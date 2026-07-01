import { Module } from '@nestjs/common';
import { ClickHouseModule } from '../clickhouse/clickhouse.module';
import { LariModule } from '../lari/lari.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DesignPartnerController } from './design-partner.controller';
import { DesignPartnerOnboardingService } from './design-partner.service';

@Module({
  imports: [PrismaModule, ClickHouseModule, LariModule],
  controllers: [DesignPartnerController],
  providers: [DesignPartnerOnboardingService],
})
export class DesignPartnerModule {}
