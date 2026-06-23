import { Module } from '@nestjs/common';
import { LariService } from '../lari/lari.service';
import { AgentRoiService } from './agent-roi.service';
import { AgentsController } from './agents.controller';

@Module({ controllers: [AgentsController], providers: [AgentRoiService, LariService] })
export class AgentsModule {}
