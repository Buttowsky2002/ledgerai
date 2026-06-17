import { Module } from '@nestjs/common';
import { PoliciesController } from './policies.controller';

@Module({ controllers: [PoliciesController] })
export class PoliciesModule {}
