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
import { env } from '../env';
import { clientMetaFromRequest, logSecurityEvent } from '../security/security-event';
import { AuthService } from './auth.service';
import { Public } from './decorators';
import { JwtService } from './jwt.service';
import { OidcService } from './oidc.service';
import { AUTH_THROTTLE } from './throttle-limits';

const ACCESS_COOKIE = 'al_access';
const REFRESH_COOKIE = 'al_refresh';
const OIDC_TX_COOKIE = 'al_oidc_tx';
const ACCESS_TTL_SECONDS = 15 * 60;
const ACCESS_COOKIE_MAX_AGE_MS = ACCESS_TTL_SECONDS * 1000; // 15 minutes
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

type SameSite = 'strict' | 'lax' | 'none';

/**
 * sameSite for the session cookies — defaults to 'strict' (security requirement:
 * the browser never sends them on cross-site requests). A cross-site deployment,
 * where the dashboard and API live on different registrable domains, can document
 * and set LEDGERAI_COOKIE_SAMESITE=lax|none so the cookies survive the cross-site
 * navigation. 'none' is meaningless without Secure, so we force secure=true then.
 */
export function cookieSameSite(): SameSite {
  const v = (env('BADGERIQ_COOKIE_SAMESITE') ?? 'strict').toLowerCase();
  return v === 'lax' || v === 'none' ? v : 'strict';
}

export function cookieOpts(maxAgeMs?: number) {
  const sameSite = cookieSameSite();
  return {
    httpOnly: true, // never readable by browser JavaScript — tokens stay off the page
    secure: process.env.NODE_ENV === 'production' || sameSite === 'none',
    sameSite,
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

/**
 * OIDC/SSO round-trip cookie (al_oidc_tx). Must be SameSite=Lax (or None) so the
 * browser sends it on the top-level GET back from the IdP. SameSite=Strict is
 * dropped on that cross-site navigation → "missing or expired login transaction".
 * Session cookies (al_access / al_refresh) stay on cookieSameSite() / Strict.
 */
export function oidcTxCookieOpts(maxAgeMs?: number) {
  const session = cookieSameSite();
  const sameSite: SameSite = session === 'none' ? 'none' : 'lax';
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || sameSite === 'none',
    sameSite,
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

/** Dashboard base URL to redirect to after a successful interactive login. */
export function dashboardUrl(): string {
  return env('BADGERIQ_DASHBOARD_URL') ?? 'http://localhost:3000';
}

/**
 * Interactive (browser) login redirects to the dashboard by default. An API
 * client can opt into the JSON token response with `?response=json` or an
 * explicit `Accept: application/json` (browser navigations don't send that).
 */
export function wantsJsonResponse(req: Request): boolean {
  if (req.query.response === 'json') {
    return true;
  }
  return (req.get('accept') ?? '').includes('application/json');
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly oidc: OidcService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Finish an interactive login: set the httpOnly session cookies (al_access +
   * al_refresh) and, by default, redirect the browser to the dashboard. An API
   * client that asked for JSON gets the access token in the body instead — the
   * cookies are set either way so the dashboard BFF works without parsing JSON.
   */
  private completeLogin(req: Request, res: Response, accessToken: string, refreshToken: string): void {
    res.cookie(ACCESS_COOKIE, accessToken, cookieOpts(ACCESS_COOKIE_MAX_AGE_MS));
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts(REFRESH_COOKIE_MAX_AGE_MS));
    if (wantsJsonResponse(req)) {
      res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS });
      return;
    }
    res.redirect(dashboardUrl());
  }

  /** Begin OIDC login: redirect to the provider with state+nonce+PKCE. */
  @Public()
  @Throttle(AUTH_THROTTLE.login)
  @Get('login/:provider')
  async login(@Param('provider') provider: string, @Res() res: Response): Promise<void> {
    const { url, state, nonce, codeVerifier } = await this.oidc.buildAuthRequest(provider);
    const tx = await this.jwt.mintState({ provider, state, nonce, codeVerifier });
    res.cookie(OIDC_TX_COOKIE, tx, oidcTxCookieOpts(10 * 60_000));
    res.redirect(url);
  }

  /** OIDC callback: validate, resolve identity, issue tokens. */
  @Public()
  @Throttle(AUTH_THROTTLE.callback)
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
    res.clearCookie(OIDC_TX_COOKIE, oidcTxCookieOpts());
    this.completeLogin(req, res, accessToken, refreshToken);
  }

  /**
   * Begin per-tenant enterprise SSO (P6-D1): resolve the email's domain to its
   * tenant IdP and redirect there. The signed oidc_tx cookie carries the resolved
   * tenant + idp so the callback can finish without server-side session state.
   */
  @Public()
  @Throttle(AUTH_THROTTLE.login)
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
    res.cookie(OIDC_TX_COOKIE, tx, oidcTxCookieOpts(10 * 60_000));
    res.redirect(url);
  }

  /** Per-tenant SSO callback: validate, JIT-provision or look up, issue tokens. */
  @Public()
  @Throttle(AUTH_THROTTLE.callback)
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
    res.clearCookie(OIDC_TX_COOKIE, oidcTxCookieOpts());
    this.completeLogin(req, res, accessToken, refreshToken);
  }

  /**
   * Renew the access token from the refresh cookie and rotate the al_access
   * cookie. The token is returned only in the httpOnly cookie — the JSON body
   * carries no token, just liveness + lifetime for the caller's refresh timer.
   */
  @Public()
  @Throttle(AUTH_THROTTLE.refresh)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res() res: Response): Promise<void> {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) {
      const meta = clientMetaFromRequest(req);
      logSecurityEvent({
        type: 'auth.login_failure',
        tenantId: null,
        userId: null,
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: { reason: 'no_refresh_token' },
      });
      throw new UnauthorizedException('no refresh token');
    }
    const { accessToken } = await this.auth.refresh(refreshToken);
    res.cookie(ACCESS_COOKIE, accessToken, cookieOpts(ACCESS_COOKIE_MAX_AGE_MS));
    // Explicit 200 (no resource created) — Nest defaults POST to 201.
    res.status(200).json({ ok: true, expires_in: ACCESS_TTL_SECONDS });
  }

  /** Clear both session cookies (access + refresh). */
  @Public()
  @Post('logout')
  logout(@Req() req: Request, @Res() res: Response): void {
    const principal = getPrincipal();
    const meta = clientMetaFromRequest(req);
    logSecurityEvent({
      type: 'auth.logout',
      tenantId: principal?.tenantId ?? null,
      userId: principal?.userId ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    res.clearCookie(ACCESS_COOKIE, cookieOpts());
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
