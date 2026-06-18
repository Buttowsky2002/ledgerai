import { Module } from '@nestjs/common';
import { RoiTemplatesController } from './roi-templates.controller';

@Module({ controllers: [RoiTemplatesController] })
export class RoiTemplatesModule {}
