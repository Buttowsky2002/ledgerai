import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Client, Issuer, generators } from 'openid-client';
import { OidcProviderConfig, loadOidcProviders } from './oidc.config';

export interface AuthRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/**
 * OIDC relying-party flow via openid-client — one discovery-driven path for both
 * Google and Microsoft. Clients are discovered lazily and cached. Login uses
 * Authorization Code + PKCE; the callback validates state, nonce, and the
 * id_token signature/claims before returning the verified email.
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private readonly configs = new Map<string, OidcProviderConfig>();
  private readonly clients = new Map<string, Client>();

  constructor() {
    for (const p of loadOidcProviders()) {
      this.configs.set(p.name, p);
    }
  }

  providerNames(): string[] {
    return [...this.configs.keys()];
  }

  async buildAuthRequest(provider: string): Promise<AuthRequest> {
    const client = await this.clientFor(provider);
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const cfg = this.configs.get(provider)!;
    const url = client.authorizationUrl({
      scope: cfg.scopes.join(' '),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return { url, state, nonce, codeVerifier };
  }

  /** Validate the callback and return the verified email. */
  async handleCallback(
    provider: string,
    params: Record<string, string>,
    expected: { state: string; nonce: string; codeVerifier: string },
  ): Promise<{ email: string }> {
    const client = await this.clientFor(provider);
    const cfg = this.configs.get(provider)!;
    const tokenSet = await client.callback(cfg.redirectUri, params, {
      state: expected.state,
      nonce: expected.nonce,
      code_verifier: expected.codeVerifier,
    });
    const claims = tokenSet.claims();
    if (!claims.email || claims.email_verified === false) {
      throw new UnauthorizedException('email missing or unverified from provider');
    }
    return { email: String(claims.email).toLowerCase() };
  }

  private async clientFor(provider: string): Promise<Client> {
    const cached = this.clients.get(provider);
    if (cached) {
      return cached;
    }
    const cfg = this.configs.get(provider);
    if (!cfg) {
      throw new BadRequestException(`unknown or unconfigured provider: ${provider}`);
    }
    this.logger.log(`discovering OIDC issuer for ${provider}`);
    const issuer = await Issuer.discover(cfg.issuer);
    const client = new issuer.Client({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uris: [cfg.redirectUri],
      response_types: ['code'],
    });
    this.clients.set(provider, client);
    return client;
  }
}
