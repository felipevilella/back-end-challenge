import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletEntity } from '../entities/wallet.entity';
import { WalletsRepository } from './wallets.repository';

@Module({
    imports: [TypeOrmModule.forFeature([WalletEntity])],
    providers: [WalletsRepository],
    exports: [WalletsRepository]
}
)
export class RepositoriesModule { }
