import { Module } from '@nestjs/common';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

/** POST /v1/import/events. PrismaService + ClickHouseService are global. */
@Module({
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
