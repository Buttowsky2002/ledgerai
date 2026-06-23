import { Module } from '@nestjs/common';
import { AgentRoiService } from './agent-roi.service';
import { AgentsController } from './agents.controller';

@Module({ controllers: [AgentsController], providers: [AgentRoiService] })
export class AgentsModule {}
