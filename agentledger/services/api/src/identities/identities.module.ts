import { Module } from '@nestjs/common';
import { IdentitiesController } from './identities.controller';

@Module({ controllers: [IdentitiesController] })
export class IdentitiesModule {}
