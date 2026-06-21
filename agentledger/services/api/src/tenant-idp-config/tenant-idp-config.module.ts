import { Module } from '@nestjs/common';
import { TenantIdpConfigController } from './tenant-idp-config.controller';

@Module({ controllers: [TenantIdpConfigController] })
export class TenantIdpConfigModule {}
