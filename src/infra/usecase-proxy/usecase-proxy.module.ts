import { DynamicModule, Module } from '@nestjs/common';
import { RepositoriesModule } from '../repositories/repositories.module';
import { WalletsRepository } from '../repositories/wallets.repository';
import { GetWalletService } from '../../module/wallets/services/get-wallet.service';
import { UseCaseProxy } from './usecase-proxy';

@Module({ imports: [RepositoriesModule] })
export class UseCaseProxyModule {
  static readonly GET_WALLET_SERVICE = 'GetWalletService';
  static register(): DynamicModule {
    return { module: UseCaseProxyModule, providers: [{
      provide: this.GET_WALLET_SERVICE, inject: [WalletsRepository],
      useFactory: (wallets: WalletsRepository) => new UseCaseProxy(new GetWalletService(wallets)),
    }], exports: [this.GET_WALLET_SERVICE] };
  }
}
