import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JWTPayload, SignJWT, jwtVerify } from 'jose';
import { Principal } from '../tenant/tenant-context';
import { env } from '../env';

const ISSUER = 'agentledger';
const AUDIENCE = 'agentledger-api';

export interface AccessClaims {
  userId: string;
  tenantId: string;
  role: string;
}

/**
 * Mints and verifies the API's own session JWTs (HS256, secret from
 * BADGERIQ_JWT_SECRET). Two token types, distinguished by `typ`: a short-lived
 * access token (sent as `Authorization: Bearer`) and a longer-lived refresh token
 * (httpOnly cookie). Verification pins issuer + audience + the expected `typ`, so
 * a refresh token can never be replayed as an access token.
 */
@Injectable()
export class JwtService {
  private readonly secret: Uint8Array;
  private readonly accessTtl: string;
  private readonly refreshTtl: string;

  constructor() {
    const raw = env('BADGERIQ_JWT_SECRET');
    if (!raw) {
      throw new Error('BADGERIQ_JWT_SECRET (or legacy BADGERIQ_JWT_SECRET) is required');
    }
    this.secret = new TextEncoder().encode(raw);
    this.accessTtl = env('BADGERIQ_JWT_ACCESS_TTL') ?? '15m';
    this.refreshTtl = env('BADGERIQ_JWT_REFRESH_TTL') ?? '7d';
  }

  async mintAccess(p: AccessClaims): Promise<string> {
    return this.sign({ tid: p.tenantId, role: p.role, typ: 'access' }, p.userId, this.accessTtl);
  }

  async mintRefresh(p: AccessClaims): Promise<string> {
    return this.sign({ tid: p.tenantId, role: p.role, typ: 'refresh' }, p.userId, this.refreshTtl);
  }

  /** Verify an access token → Principal. Throws 401 on any failure. */
  async verifyAccess(token: string): Promise<Principal> {
    const payload = await this.verify(token, 'access');
    return { userId: payload.sub ?? null, tenantId: (payload.tid as string) ?? null, role: (payload.role as string) ?? null };
  }

  /** Verify a refresh token → claims for re-minting. Throws 401 on any failure. */
  async verifyRefresh(token: string): Promise<AccessClaims> {
    const payload = await this.verify(token, 'refresh');
    if (!payload.sub || !payload.tid) {
      throw new UnauthorizedException('malformed refresh token');
    }
    return { userId: payload.sub, tenantId: payload.tid as string, role: (payload.role as string) ?? 'viewer' };
  }

  /**
   * Short-lived signed envelope (~10m) for the OIDC login transaction — carries
   * state/nonce/PKCE code_verifier in an httpOnly cookie so the callback can
   * validate them without server-side session storage.
   */
  async mintState(data: Record<string, string>): Promise<string> {
    return this.sign({ ...data, typ: 'oidc_tx' }, 'oidc', '10m');
  }

  async verifyState(token: string): Promise<Record<string, string>> {
    const payload = await this.verify(token, 'oidc_tx');
    return payload as Record<string, string>;
  }

  private async sign(claims: JWTPayload, subject: string, ttl: string): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(ttl)
      .sign(this.secret);
  }

  private async verify(token: string, expectedTyp: 'access' | 'refresh' | 'oidc_tx'): Promise<JWTPayload> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, audience: AUDIENCE }));
    } catch {
      throw new UnauthorizedException('invalid token');
    }
    if (payload.typ !== expectedTyp) {
      throw new UnauthorizedException('wrong token type');
    }
    return payload;
  }
}
