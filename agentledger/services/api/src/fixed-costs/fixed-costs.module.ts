import { Module } from '@nestjs/common';
import { FixedCostsController } from './fixed-costs.controller';
import { FixedCostsService } from './fixed-costs.service';

@Module({
  controllers: [FixedCostsController],
  providers: [FixedCostsService],
  exports: [FixedCostsService],
})
export class FixedCostsModule {}
