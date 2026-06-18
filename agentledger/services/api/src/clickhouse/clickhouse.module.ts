import { Global, Module } from '@nestjs/common';
import { ClickHouseService } from './clickhouse.service';

/** Global so analytics (and the health check) can inject the client. */
@Global()
@Module({
  providers: [ClickHouseService],
  exports: [ClickHouseService],
})
export class ClickHouseModule {}
