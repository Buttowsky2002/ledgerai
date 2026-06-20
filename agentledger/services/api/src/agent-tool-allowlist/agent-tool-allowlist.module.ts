import { Module } from '@nestjs/common';
import { AgentToolAllowlistController } from './agent-tool-allowlist.controller';

@Module({ controllers: [AgentToolAllowlistController] })
export class AgentToolAllowlistModule {}
