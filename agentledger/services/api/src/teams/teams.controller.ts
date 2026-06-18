import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { Roles } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

class CreateTeamDto {
  @IsString() name!: string;
  @IsOptional() @IsString() costCenter?: string;
  @IsOptional() @IsUUID() parentTeamId?: string;
}

class UpdateTeamDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() costCenter?: string;
  @IsOptional() @IsUUID() parentTeamId?: string;
}

@Controller('v1/teams')
export class TeamsController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, { model: 'team', idField: 'teamId', object: 'team' });
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
  create(@Body() dto: CreateTeamDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTeamDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}
