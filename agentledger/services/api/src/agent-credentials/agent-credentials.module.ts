import { Module } from '@nestjs/common';
import { AgentCredentialsController } from './agent-credentials.controller';

@Module({ controllers: [AgentCredentialsController] })
export class AgentCredentialsModule {}
