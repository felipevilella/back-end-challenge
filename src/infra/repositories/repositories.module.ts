import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { persistenceEntities } from '../entities';
import { FinancialRepository } from './financial.repository';
import { WalletsRepository } from './wallets.repository';

@Module({
  imports: [TypeOrmModule.forFeature(persistenceEntities)],
  providers: [WalletsRepository, FinancialRepository],
  exports: [WalletsRepository, FinancialRepository],
})
export class RepositoriesModule {}
