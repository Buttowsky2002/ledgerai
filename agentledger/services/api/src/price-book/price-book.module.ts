import { Module } from '@nestjs/common';
import { PriceBookController } from './price-book.controller';

@Module({ controllers: [PriceBookController] })
export class PriceBookModule {}
