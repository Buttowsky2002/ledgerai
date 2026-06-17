import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/decorators';
import { CrudService } from '../common/crud.service';
import { parsePagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

const TOKEN_TYPES = ['input', 'output', 'cache_read', 'cache_write'];

class CreatePriceDto {
  @IsString() provider!: string;
  @IsString() modelPrefix!: string;
  @IsIn(TOKEN_TYPES) tokenType!: string;
  @IsNumber() usdPerMillion!: number;
  @IsString() source!: string;
  @IsDateString() effectiveStart!: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsDateString() effectiveEnd?: string;
}

class UpdatePriceDto {
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() modelPrefix?: string;
  @IsOptional() @IsIn(TOKEN_TYPES) tokenType?: string;
  @IsOptional() @IsNumber() usdPerMillion?: number;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsDateString() effectiveStart?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsDateString() effectiveEnd?: string;
}

/**
 * Price book is GLOBAL reference data (no tenant_id, no RLS). Reads are open to any
 * authenticated user; writes are admin-only (migration 004 grants the API role
 * write access). injectTenant:false so create doesn't add a tenant_id column.
 */
@Controller('v1/price-book')
export class PriceBookController {
  private readonly crud: CrudService;
  constructor(prisma: PrismaService) {
    this.crud = new CrudService(prisma, {
      model: 'priceBook',
      idField: 'priceId',
      object: 'price_book',
      injectTenant: false,
    });
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
  create(@Body() dto: CreatePriceDto) {
    return this.crud.create({ ...dto });
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePriceDto) {
    return this.crud.update(id, { ...dto });
  }

  @Roles('admin') @Delete(':id')
  remove(@Param('id') id: string) {
    return this.crud.remove(id);
  }
}
