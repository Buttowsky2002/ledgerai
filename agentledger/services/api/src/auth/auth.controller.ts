import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { getPrincipal } from '../tenant/tenant-context';
import { AuthService } from './auth.service';
import { Public } from './decorators';
import { JwtService } from './jwt.service';
import { OidcService } from './oidc.service';

const REFRESH_COOKIE = 'al_refresh';
const OIDC_TX_COOKIE = 'al_oidc_tx';
const ACCESS_TTL_SECONDS = 15 * 60;

// Classify the IdP issuer into an identities.source label (manual|scim|okta|
// entra|hris|oidc). Best-effort — purely informational provenance.
function sourceFromIssuer(issuer: string): string {
  const i = issuer.toLowerCase();
  if (i.includes('okta')) {
    return 'okta';
  }
  if (i.includes('microsoftonline') || i.includes('windows.net') || i.includes('entra')) {
    return 'entra';
  }
  return 'oidc';
}

function cookieOpts(maxAgeMs?: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

@Controller('auth')
// Stricter rate limit on auth endpoints (security rule 6) than the global default.
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly oidc: OidcService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  /** Begin OIDC login: redirect to the provider with state+nonce+PKCE. */
  @Public()
  @Get('login/:provider')
  async login(@Param('provider') provider: string, @Res() res: Response): Promise<void> {
    const { url, state, nonce, codeVerifier } = await this.oidc.buildAuthRequest(provider);
    const tx = await this.jwt.mintState({ provider, state, nonce, codeVerifier });
    res.cookie(OIDC_TX_COOKIE, tx, cookieOpts(10 * 60_000));
    res.redirect(url);
  }

  /** OIDC callback: validate, resolve identity, issue tokens. */
  @Public()
  @Get('callback/:provider')
  async callback(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const txCookie = req.cookies?.[OIDC_TX_COOKIE];
    if (!txCookie) {
      throw new BadRequestException('missing or expired login transaction');
    }
    const tx = await this.jwt.verifyState(txCookie);
    if (tx.provider !== provider) {
      throw new BadRequestException('provider mismatch');
    }
    const { email } = await this.oidc.handleCallback(provider, req.query as Record<string, string>, {
      state: tx.state,
      nonce: tx.nonce,
      codeVerifier: tx.codeVerifier,
    });
    const { accessToken, refreshToken } = await this.auth.loginByEmail(email);
    res.clearCookie(OIDC_TX_COOKIE, cookieOpts());
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts(7 * 24 * 60 * 60_000));
    // No dashboard yet (task 6 will redirect into the SPA); return the access token.
    res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS });
  }

  /**
   * Begin per-tenant enterprise SSO (P6-D1): resolve the email's domain to its
   * tenant IdP and redirect there. The signed oidc_tx cookie carries the resolved
   * tenant + idp so the callback can finish without server-side session state.
   */
  @Public()
  @Get('sso/login')
  async ssoLogin(@Query('email') email: string, @Res() res: Response): Promise<void> {
    if (!email || !email.includes('@')) {
      throw new BadRequestException('email query parameter required');
    }
    const domain = email.split('@').pop()!.toLowerCase();
    const idp = await this.auth.lookupIdpByDomain(domain);
    if (!idp) {
      throw new UnauthorizedException('no SSO configured for this domain');
    }
    const { url, state, nonce, codeVerifier } = await this.oidc.buildTenantAuthRequest({
      idpId: idp.idp_id,
      issuer: idp.issuer,
      clientId: idp.client_id,
      clientSecretRef: idp.client_secret_ref,
    });
    const tx = await this.jwt.mintState({
      flow: 'sso',
      idpId: idp.idp_id,
      tenantId: idp.tenant_id,
      state,
      nonce,
      codeVerifier,
    });
    res.cookie(OIDC_TX_COOKIE, tx, cookieOpts(10 * 60_000));
    res.redirect(url);
  }

  /** Per-tenant SSO callback: validate, JIT-provision or look up, issue tokens. */
  @Public()
  @Get('sso/callback')
  async ssoCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const txCookie = req.cookies?.[OIDC_TX_COOKIE];
    if (!txCookie) {
      throw new BadRequestException('missing or expired login transaction');
    }
    const tx = await this.jwt.verifyState(txCookie);
    if (tx.flow !== 'sso') {
      throw new BadRequestException('wrong login flow');
    }
    const idp = await this.auth.getTenantIdp(tx.tenantId, tx.idpId);
    if (!idp) {
      throw new BadRequestException('IdP no longer configured');
    }
    const { email, sub } = await this.oidc.handleTenantCallback(
      { idpId: idp.idp_id, issuer: idp.issuer, clientId: idp.client_id, clientSecretRef: idp.client_secret_ref },
      req.query as Record<string, string>,
      { state: tx.state, nonce: tx.nonce, codeVerifier: tx.codeVerifier },
    );
    const { accessToken, refreshToken } = await this.auth.provisionAndLogin({
      tenantId: idp.tenant_id,
      email,
      sub,
      source: sourceFromIssuer(idp.issuer),
      jitEnabled: idp.jit_enabled,
      defaultApiRole: idp.default_api_role,
    });
    res.clearCookie(OIDC_TX_COOKIE, cookieOpts());
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts(7 * 24 * 60 * 60_000));
    res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS });
  }

  /** Mint a fresh access token from the refresh cookie. */
  @Public()
  @Post('refresh')
  async refresh(@Req() req: Request, @Res() res: Response): Promise<void> {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException('no refresh token');
    }
    const { accessToken } = await this.auth.refresh(refreshToken);
    // Explicit 200 (no resource created) — Nest defaults POST to 201.
    res.status(200).json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS });
  }

  /** Clear the refresh cookie. */
  @Public()
  @Post('logout')
  logout(@Res() res: Response): void {
    res.clearCookie(REFRESH_COOKIE, cookieOpts());
    res.status(204).send();
  }

  /** Current principal (requires a valid access token — not @Public). */
  @Get('me')
  me() {
    const principal = getPrincipal();
    if (!principal || !principal.tenantId) {
      throw new UnauthorizedException('authentication required');
    }
    return { userId: principal.userId, tenantId: principal.tenantId, role: principal.role };
  }
}
