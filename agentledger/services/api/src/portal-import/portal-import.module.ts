import { Module } from '@nestjs/common';
import { ImportModule } from '../import/import.module';
import { PortalImportController } from './portal-import.controller';
import { PortalImportService } from './portal-import.service';

@Module({
  imports: [ImportModule],
  controllers: [PortalImportController],
  providers: [PortalImportService],
})
export class PortalImportModule {}
