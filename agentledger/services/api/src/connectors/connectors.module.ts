import { Module } from '@nestjs/common';
import { ImportModule } from '../import/import.module';
import { ImportService } from '../import/import.service';
import { ConnectorDefinitionsController, ConnectorsController } from './connectors.controller';
import { ConnectorDefinitionsService } from './connector-definitions.service';
import { ConnectorSecretsService } from './connector-secrets.service';
import { ConnectorsService } from './connectors.service';

@Module({
  imports: [ImportModule],
  controllers: [ConnectorDefinitionsController, ConnectorsController],
  providers: [ConnectorDefinitionsService, ConnectorSecretsService, ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
