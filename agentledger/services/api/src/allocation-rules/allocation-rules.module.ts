import { Module } from '@nestjs/common';
import { AllocationRulesController } from './allocation-rules.controller';

@Module({ controllers: [AllocationRulesController] })
export class AllocationRulesModule {}
