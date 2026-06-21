import { Module } from '@nestjs/common';
import { ScimAuthGuard } from './scim-auth.guard';
import { ScimController } from './scim.controller';
import { ScimService } from './scim.service';

@Module({
  controllers: [ScimController],
  providers: [ScimService, ScimAuthGuard],
})
export class ScimModule {}
