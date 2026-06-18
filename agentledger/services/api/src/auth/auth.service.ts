import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessClaims, JwtService } from './jwt.service';

interface IdentityRow {
  user_id: string;
  tenant_id: string;
  api_role: string;
}

/**
 * Turns a verified SSO email into session tokens. The email→identity lookup goes
 * through the auth_lookup_identity() SECURITY DEFINER function (migration 003) —
 * the one controlled RLS bypass — because no tenant is bound yet at login. Unknown
 * emails are rejected (no auto-provisioning in this task).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async loginByEmail(email: string): Promise<{ accessToken: string; refreshToken: string; claims: AccessClaims }> {
    // Parameterised ($1) — never string-concatenated (rule 4).
    const rows = await this.prisma.$queryRaw<IdentityRow[]>`
      SELECT user_id, tenant_id, api_role FROM auth_lookup_identity(${email})`;
    if (rows.length === 0) {
      throw new UnauthorizedException('no identity provisioned for this email');
    }
    const claims: AccessClaims = {
      userId: rows[0].user_id,
      tenantId: rows[0].tenant_id,
      role: rows[0].api_role,
    };
    return {
      accessToken: await this.jwt.mintAccess(claims),
      refreshToken: await this.jwt.mintRefresh(claims),
      claims,
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; claims: AccessClaims }> {
    const claims = await this.jwt.verifyRefresh(refreshToken);
    return { accessToken: await this.jwt.mintAccess(claims), claims };
  }
}
