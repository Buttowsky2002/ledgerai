import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { getTenantId } from '../tenant/tenant-context';
import { CopilotMemberSpendService } from './github-copilot-member-spend.service';
import { GitHubCopilotService } from './github-copilot.service';
import { CopilotRoiAssumptions } from './github-copilot.types';

class CreateConnectionBody {
  @IsString() displayName!: string;
  @IsString() orgSlug!: string;
  @IsString() githubToken!: string;
  @IsOptional() @IsString() enterpriseSlug?: string;
  @IsOptional() @IsObject() roiAssumptions?: Partial<CopilotRoiAssumptions>;
  @IsOptional() @IsObject() scheduleJson?: Record<string, unknown>;
}

class TestTokenBody {
  @IsString() githubToken!: string;
  @IsString() orgSlug!: string;
}

class UpdateAssumptionsBody {
  @IsObject() roiAssumptions!: Partial<CopilotRoiAssumptions>;
}

@Controller('v1/github-copilot')
export class GitHubCopilotController {
  constructor(
    private readonly copilot: GitHubCopilotService,
    private readonly memberSpend: CopilotMemberSpendService,
  ) {}

  @Roles('viewer') @Get('overview')
  overview(@Query('from') from?: string, @Query('to') to?: string) {
    return this.copilot.getOverview(from, to);
  }

  @Roles('viewer') @Get('member-spend')
  memberSpendView(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('month') month?: string,
    @Query('team') team?: string,
    @Query('user') user?: string,
    @Query('utilizationStatus') utilizationStatus?: string,
    @Query('model') model?: string,
    @Query('editor') editor?: string,
    @Query('language') language?: string,
  ) {
    const tenantId = getTenantId();
    return this.memberSpend.getMemberSpend(tenantId!, {
      from,
      to,
      month,
      team,
      user,
      utilizationStatus,
      model,
      editor,
      language,
    });
  }

  @Roles('viewer') @Get('connections')
  listConnections() {
    return this.copilot.listConnections();
  }

  @Roles('viewer') @Get('connections/:id')
  getConnection(@Param('id') id: string) {
    return this.copilot.getConnection(id);
  }

  @Roles('admin') @Post('connections')
  createConnection(@Body() body: CreateConnectionBody) {
    return this.copilot.createConnection(body);
  }

  @Roles('admin') @Post('connections/test-token')
  testToken(@Body() body: TestTokenBody) {
    return this.copilot.testToken(body.githubToken, body.orgSlug);
  }

  @Roles('admin') @Patch('connections/:id/roi-assumptions')
  updateAssumptions(@Param('id') id: string, @Body() body: UpdateAssumptionsBody) {
    return this.copilot.updateRoiAssumptions(id, body.roiAssumptions);
  }

  @Roles('admin') @Post('connections/:id/sync')
  syncNow(@Param('id') id: string) {
    return this.copilot.syncNow(id);
  }
}
