import { Module } from '@nestjs/common';
import { VirtualKeysController } from './virtual-keys.controller';
import { VirtualKeysService } from './virtual-keys.service';

@Module({ controllers: [VirtualKeysController], providers: [VirtualKeysService] })
export class VirtualKeysModule {}
