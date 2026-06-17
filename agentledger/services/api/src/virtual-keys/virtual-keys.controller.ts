import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { Roles } from '../auth/decorators';
import { parsePagination } from '../common/pagination';
import { VirtualKeysService } from './virtual-keys.service';

class CreateVirtualKeyDto {
  @IsString() name!: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() appId?: string;
  @IsOptional() @IsString() environment?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedModels?: string[];
  @IsOptional() @IsNumber() monthlyBudgetUsd?: number;
  @IsOptional() @IsInt() rateLimitRpm?: number;
  @IsOptional() @IsUUID() dlpPolicyId?: string;
}

class UpdateVirtualKeyDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() environment?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedModels?: string[];
  @IsOptional() @IsNumber() monthlyBudgetUsd?: number;
  @IsOptional() @IsInt() rateLimitRpm?: number;
  @IsOptional() @IsUUID() dlpPolicyId?: string;
}

@Controller('v1/virtual-keys')
export class VirtualKeysController {
  constructor(private readonly keys: VirtualKeysService) {}

  @Roles('viewer') @Get()
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.keys.list(parsePagination(limit, offset));
  }

  @Roles('viewer') @Get(':id')
  get(@Param('id') id: string) {
    return this.keys.get(id);
  }

  /** Returns the plaintext key exactly once. */
  @Roles('admin') @Post()
  create(@Body() dto: CreateVirtualKeyDto) {
    return this.keys.create(dto);
  }

  @Roles('admin') @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateVirtualKeyDto) {
    return this.keys.update(id, dto);
  }

  /** Revoke (soft delete). */
  @Roles('admin') @Delete(':id')
  revoke(@Param('id') id: string) {
    return this.keys.revoke(id);
  }
}
