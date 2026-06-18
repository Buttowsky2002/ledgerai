import { Controller, Get, Header, Module } from '@nestjs/common';
import { collectDefaultMetrics, register } from 'prom-client';
import { Public } from '../auth/decorators';

// Register process/runtime metrics once at module load.
collectDefaultMetrics({ prefix: 'agentledger_api_' });

@Public()
@Controller()
class MetricsController {
  @Get('metrics')
  @Header('Content-Type', register.contentType)
  async metrics(): Promise<string> {
    return register.metrics();
  }
}

@Module({
  controllers: [MetricsController],
})
export class MetricsModule {}
