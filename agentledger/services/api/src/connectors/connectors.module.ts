import { Module } from '@nestjs/common';
import { ImportModule } from '../import/import.module';
import { ConnectorDefinitionsController, ConnectorsController } from './connectors.controller';
import { ConnectorDefinitionsService } from './connector-definitions.service';
import { ConnectorSchedulerService } from './connector-scheduler.service';
import { ConnectorSecretsService } from './connector-secrets.service';
import { ConnectorsService } from './connectors.service';
import { AttributionMappingsService } from './attribution/attribution-mappings.service';

@Module({
  imports: [ImportModule],
  controllers: [ConnectorDefinitionsController, ConnectorsController],
  providers: [
    ConnectorDefinitionsService,
    ConnectorSecretsService,
    ConnectorsService,
    ConnectorSchedulerService,
    AttributionMappingsService,
  ],
  exports: [ConnectorsService, ConnectorSecretsService, AttributionMappingsService],
})
export class ConnectorsModule {}
