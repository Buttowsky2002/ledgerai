import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators';
import { SCIM_THROTTLE } from '../auth/throttle-limits';
import { ScimAuthGuard, ScimRequest } from './scim-auth.guard';
import { ScimCtx, ScimService } from './scim.service';
import { parsePatch, scimError } from './scim.types';

const MAX_COUNT = 200;

/**
 * SCIM 2.0 provisioning endpoint (RFC 7643/7644), mounted at /scim/v2. Tenant
 * IdPs (Okta/Entra/…) call it with a per-tenant bearer token (ScimAuthGuard) —
 * not session/JWT cookies. @Public exempts it from the JWT AuthGuard; the SCIM
 * guard authenticates instead and resolves the tenant, which every handler
 * passes explicitly to the service. Throttle is tighter than the global API
 * default but high enough for typical IdP sync bursts.
 */
@Public()
@UseGuards(ScimAuthGuard)
@Throttle(SCIM_THROTTLE)
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  // ---- discovery (RFC 7643 §5) ----

  @Get('ServiceProviderConfig')
  @Header('Content-Type', 'application/scim+json')
  serviceProviderConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_COUNT },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        { type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'Per-tenant SCIM bearer token' },
      ],
    };
  }

  @Get('ResourceTypes')
  @Header('Content-Type', 'application/scim+json')
  resourceTypes() {
    return [
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: 'urn:ietf:params:scim:schemas:core:2.0:User' },
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: 'urn:ietf:params:scim:schemas:core:2.0:Group' },
    ];
  }

  @Get('Schemas')
  @Header('Content-Type', 'application/scim+json')
  schemas() {
    return [
      { id: 'urn:ietf:params:scim:schemas:core:2.0:User', name: 'User' },
      { id: 'urn:ietf:params:scim:schemas:core:2.0:Group', name: 'Group' },
    ];
  }

  // ---- Users ----

  @Get('Users')
  @Header('Content-Type', 'application/scim+json')
  listUsers(
    @Req() req: ScimRequest,
    @Query('filter') filter?: string,
    @Query('startIndex') startIndex?: string,
    @Query('count') count?: string,
  ) {
    return this.scim.listUsers(ctx(req), parseUserFilter(filter), parseInt1(startIndex, 1), parseCount(count), base(req));
  }

  @Get('Users/:id')
  @Header('Content-Type', 'application/scim+json')
  getUser(@Req() req: ScimRequest, @Param('id') id: string) {
    return this.scim.getUser(ctx(req), id, base(req));
  }

  @Post('Users')
  @Header('Content-Type', 'application/scim+json')
  createUser(@Req() req: ScimRequest, @Body() body: Record<string, unknown>) {
    return this.scim.createUser(ctx(req), body, base(req));
  }

  @Put('Users/:id')
  @Header('Content-Type', 'application/scim+json')
  replaceUser(@Req() req: ScimRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.scim.replaceUser(ctx(req), id, body, base(req));
  }

  @Patch('Users/:id')
  @Header('Content-Type', 'application/scim+json')
  patchUser(@Req() req: ScimRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.scim.patchUser(ctx(req), id, parsePatchOrThrow(body), base(req));
  }

  @Delete('Users/:id')
  @HttpCode(204)
  deleteUser(@Req() req: ScimRequest, @Param('id') id: string) {
    return this.scim.deleteUser(ctx(req), id);
  }

  // ---- Groups ----

  @Get('Groups')
  @Header('Content-Type', 'application/scim+json')
  listGroups(@Req() req: ScimRequest, @Query('startIndex') startIndex?: string, @Query('count') count?: string) {
    return this.scim.listGroups(ctx(req), parseInt1(startIndex, 1), parseCount(count), base(req));
  }

  @Get('Groups/:id')
  @Header('Content-Type', 'application/scim+json')
  getGroup(@Req() req: ScimRequest, @Param('id') id: string) {
    return this.scim.getGroup(ctx(req), id, base(req));
  }

  @Post('Groups')
  @Header('Content-Type', 'application/scim+json')
  createGroup(@Req() req: ScimRequest, @Body() body: Record<string, unknown>) {
    return this.scim.createGroup(ctx(req), body, base(req));
  }

  @Put('Groups/:id')
  @Header('Content-Type', 'application/scim+json')
  replaceGroup(@Req() req: ScimRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.scim.replaceGroup(ctx(req), id, body, base(req));
  }

  @Patch('Groups/:id')
  @Header('Content-Type', 'application/scim+json')
  patchGroup(@Req() req: ScimRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.scim.patchGroup(ctx(req), id, parsePatchOrThrow(body), base(req));
  }

  @Delete('Groups/:id')
  @HttpCode(204)
  deleteGroup(@Req() req: ScimRequest, @Param('id') id: string) {
    return this.scim.deleteGroup(ctx(req), id);
  }
}

// ---- request helpers ----

function ctx(req: ScimRequest): ScimCtx {
  // ScimAuthGuard guarantees req.scim is set before any handler runs.
  return req.scim!;
}

function base(req: ScimRequest): string {
  return `${req.protocol}://${req.get('host')}/scim/v2`;
}

function parseUserFilter(filter?: string): string | null {
  if (!filter) {
    return null;
  }
  const m = /userName\s+eq\s+"([^"]+)"/i.exec(filter);
  return m ? m[1].toLowerCase() : null;
}

function parseInt1(v: string | undefined, def: number): number {
  const n = v ? parseInt(v, 10) : def;
  return Number.isFinite(n) && n > 0 ? n : def;
}

function parseCount(v: string | undefined): number {
  return Math.min(parseInt1(v, 100), MAX_COUNT);
}

function parsePatchOrThrow(body: Record<string, unknown>) {
  try {
    return parsePatch(body);
  } catch (e) {
    throw new HttpException(scimError(400, String(e instanceof Error ? e.message : e), 'invalidValue'), 400);
  }
}
