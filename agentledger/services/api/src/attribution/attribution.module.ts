import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AttributionController } from './attribution.controller';
import { AttributionService } from './attribution.service';

@Module({
  imports: [PrismaModule],
  controllers: [AttributionController],
  providers: [AttributionService],
})
export class AttributionModule {}
