import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsEmail, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

const ROLES = ['member', 'admin', 'finance', 'security'];
const API_ROLES = ['viewer', 'analyst', 'admin'];

class CreateIdentityDto {
  @IsEmail() email!: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() managerId?: string;
  @IsOptional() @IsIn(ROLES) role?: string;
  @IsOptional() @IsIn(API_ROLES) apiRole?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsArray() aliases?: unknown[];
}

class UpdateIdentityDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() managerId?: string;
  @IsOptional() @IsIn(ROLES) role?: string;
  @IsOptional() @IsIn(API_ROLES) apiRole?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsArray() aliases?: unknown[];
}

@Controller('v1/identities')
export class IdentitiesController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, { model: 'identity', idField: 'userId', object: 'identity' });
  }

  @Roles('viewer') @Get()
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.crud.list(parsePagination(limit, offset));
  }

  @Roles('viewer') @Get(':id')
  get(@Param('id') id: string) {
    return this.crud.get(id);
  }

  @Roles('admin') @Post()
  create(@Body() dto: CreateIdentityDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateIdentityDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}
