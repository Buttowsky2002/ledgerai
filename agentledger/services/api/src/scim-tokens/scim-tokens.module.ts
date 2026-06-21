import { Module } from '@nestjs/common';
import { ScimTokensController } from './scim-tokens.controller';

@Module({ controllers: [ScimTokensController] })
export class ScimTokensModule {}
