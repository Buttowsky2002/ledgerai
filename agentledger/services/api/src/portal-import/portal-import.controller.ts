import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';

import { Type } from 'class-transformer';

import {

  IsArray,

  IsBoolean,

  IsIn,

  IsOptional,

  IsString,

  ValidateNested,

} from 'class-validator';

import { Roles } from '../auth/decorators';

import { PortalImportService } from './portal-import.service';



class ColumnMappingDto {
  @IsOptional() @IsString() date?: string;

  @IsString() cost!: string;

  @IsOptional() @IsIn(['usd', 'cents']) costUnit?: 'usd' | 'cents';

  @IsOptional() @IsString() reportThroughDay?: string;

  @IsOptional() @IsString() model?: string;

  @IsOptional() @IsString() product?: string;

  @IsOptional() @IsString() user?: string;

  @IsOptional() @IsString() user_name?: string;

  @IsOptional() @IsString() user_id?: string;

  @IsOptional() @IsString() account_uuid?: string;

  @IsOptional() @IsString() input_tokens?: string;

  @IsOptional() @IsString() output_tokens?: string;
}



class PortalFileDto {

  @IsString() name!: string;

  @IsString() csv!: string;

  @IsOptional() @ValidateNested() @Type(() => ColumnMappingDto) mapping?: ColumnMappingDto;

  @IsOptional() @IsString() provider?: string;

}



class AnthropicPortalPreviewDto {

  @IsString() csv!: string;

  @IsOptional() @IsString() fileName?: string;

  @IsOptional() @ValidateNested() @Type(() => ColumnMappingDto) mapping?: ColumnMappingDto;

  @IsOptional() @IsString() provider?: string;

}



class AnthropicPortalUploadDto {

  @IsOptional() @IsString() csv?: string;

  @IsOptional() @IsString() fileName?: string;

  @IsOptional() @ValidateNested() @Type(() => ColumnMappingDto) mapping?: ColumnMappingDto;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PortalFileDto) files?: PortalFileDto[];

  @IsOptional() @IsString() provider?: string;

  @IsOptional() @IsString() connectorId?: string;

  @IsOptional() @IsBoolean() dryRun?: boolean;

}



@Controller('v1/portal-import')

export class PortalImportController {

  constructor(private readonly portalImport: PortalImportService) {}



  /** Analyze CSV headers, suggest mapping, return preview rows (no import). */

  @Roles('admin')

  @Post('anthropic/preview')

  previewAnthropic(@Body() dto: AnthropicPortalPreviewDto) {

    return this.portalImport.previewAnthropicCsv(dto.csv, {

      fileName: dto.fileName,

      mapping: dto.mapping,

      provider: dto.provider,

    });

  }



  /** Import one or more Anthropic billing CSVs with optional column mapping. */

  @Roles('admin')

  @Post('anthropic')

  uploadAnthropic(@Body() dto: AnthropicPortalUploadDto) {

    if (dto.files?.length) {

      return this.portalImport.uploadAnthropicBatch(dto.files, {

        connectorId: dto.connectorId,

        dryRun: dto.dryRun,

      });

    }

    if (!dto.csv?.trim()) {

      return this.portalImport.uploadAnthropicBatch([], { dryRun: dto.dryRun });

    }

    return this.portalImport.uploadAnthropicCsv(dto.csv, {

      connectorId: dto.connectorId,

      dryRun: dto.dryRun,

      mapping: dto.mapping,

      fileName: dto.fileName,

      provider: dto.provider,

    });

  }

  /** List portal billing import runs (new runs + legacy audit entries). */
  @Roles('admin')
  @Get('runs')
  listRuns(@Query('limit') limit?: string) {
    const n = limit ? Number(limit) : 50;
    return this.portalImport.listImportRuns(Number.isFinite(n) ? n : 50);
  }

  /** Delete imported spend from one run — updates platform totals immediately. */
  @Roles('admin')
  @Delete('runs/:runId')
  deleteRun(@Param('runId') runId: string) {
    return this.portalImport.deleteImportRun(runId);
  }

}


