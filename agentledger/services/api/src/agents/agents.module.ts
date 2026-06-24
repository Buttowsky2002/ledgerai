import { Module } from '@nestjs/common';
import { LariModule } from '../lari/lari.module';
import { AgentRoiService } from './agent-roi.service';
import { AgentsController } from './agents.controller';

@Module({
  imports: [LariModule],
  controllers: [AgentsController],
  providers: [AgentRoiService],
})
export class AgentsModule {}
