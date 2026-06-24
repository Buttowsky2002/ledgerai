import { Module } from '@nestjs/common';
import { LariService } from './lari.service';

/** Exposes the LARI engine so both AgentsModule (per-agent endpoint) and
 *  AnalyticsModule (the agent-economics rollup) can reuse one service. */
@Module({ providers: [LariService], exports: [LariService] })
export class LariModule {}
