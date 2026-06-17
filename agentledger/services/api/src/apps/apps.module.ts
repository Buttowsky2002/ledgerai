import { Module } from '@nestjs/common';
import { AppsController } from './apps.controller';

@Module({ controllers: [AppsController] })
export class AppsModule {}
