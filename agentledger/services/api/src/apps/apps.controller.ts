import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

const APP_TYPES = ['service', 'agent', 'notebook', 'saas', 'dev_tool'];
const APPROVED = ['approved', 'pending', 'denied', 'shadow'];

class CreateAppDto {
  @IsString() name!: string;
  @IsOptional() @IsIn(APP_TYPES) appType?: string;
  @IsOptional() @IsUUID() ownerUserId?: string;
  @IsOptional() @IsString() environment?: string;
  @IsOptional() @IsIn(APPROVED) approvedStatus?: string;
  @IsOptional() @IsString() businessFunction?: string;
}

class UpdateAppDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(APP_TYPES) appType?: string;
  @IsOptional() @IsUUID() ownerUserId?: string;
  @IsOptional() @IsString() environment?: string;
  @IsOptional() @IsIn(APPROVED) approvedStatus?: string;
  @IsOptional() @IsString() businessFunction?: string;
}

@Controller('v1/apps')
export class AppsController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, { model: 'app', idField: 'appId', object: 'app' });
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
  create(@Body() dto: CreateAppDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAppDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}
