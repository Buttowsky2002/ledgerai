import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtService } from './jwt.service';
import { OidcService } from './oidc.service';

/**
 * Authentication + token services. Guards (AuthGuard/RolesGuard) are registered
 * globally in AppModule via APP_GUARD; JwtService is exported so AuthMiddleware
 * can verify access tokens.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtService, OidcService],
  exports: [JwtService],
})
export class AuthModule {}
