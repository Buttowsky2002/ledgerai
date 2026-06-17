import { Module } from '@nestjs/common';
import { BudgetsController } from './budgets.controller';

@Module({ controllers: [BudgetsController] })
export class BudgetsModule {}
