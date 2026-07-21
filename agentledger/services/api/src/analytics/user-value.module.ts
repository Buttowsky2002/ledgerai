import { Module } from '@nestjs/common';
import { ClickHouseModule } from '../clickhouse/clickhouse.module';
import { UserValueService } from './user-value.service';

@Module({
  imports: [ClickHouseModule],
  providers: [UserValueService],
  exports: [UserValueService],
})
export class UserValueModule {}
