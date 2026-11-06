import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseOptions } from './typeorm.config';

@Module({ imports: [TypeOrmModule.forRootAsync({ useFactory: databaseOptions })] })
export class TypeOrmConfigModule {}
