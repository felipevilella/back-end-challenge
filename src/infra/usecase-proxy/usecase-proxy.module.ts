import { type DynamicModule, Module } from '@nestjs/common';
import { RepositoriesModule } from '../repositories/repositories.module';
import { WalletsRepository } from '../repositories/wallets.repository';
import { FinancialRepository } from '../repositories/financial.repository';
import { GetWalletService } from '../../module/wallets/services/get-wallet.service';
import { ProcessWagerService } from '../../module/wagering/services/process-wager.service';
import { WalletOperationsService } from '../../module/wagering/services/wallet-operations.service';
import { UseCaseProxy } from './usecase-proxy';
import { Telemetry, ObservabilityModule } from '../observability/telemetry';

@Module({ imports: [RepositoriesModule, ObservabilityModule] })
export class UseCaseProxyModule {
  static readonly GET_WALLET_SERVICE = 'GetWalletService';

  static readonly PROCESS_WAGER_SERVICE = 'ProcessWagerService';

  static readonly WALLET_OPERATIONS_SERVICE = 'WalletOperationsService';

  static register(): DynamicModule {
    return {
      module: UseCaseProxyModule,
      providers: [
        {
          provide: this.GET_WALLET_SERVICE,
          inject: [WalletsRepository],
          useFactory: (wallets: WalletsRepository) =>
            new UseCaseProxy(new GetWalletService(wallets)),
        },
        {
          provide: this.PROCESS_WAGER_SERVICE,
          inject: [FinancialRepository, Telemetry],
          useFactory: (financial: FinancialRepository, telemetry: Telemetry) =>
            new UseCaseProxy(new ProcessWagerService(financial, telemetry)),
        },
        {
          provide: this.WALLET_OPERATIONS_SERVICE,
          inject: [FinancialRepository],
          useFactory: (financial: FinancialRepository) =>
            new UseCaseProxy(new WalletOperationsService(financial)),
        },
      ],
      exports: [
        this.GET_WALLET_SERVICE,
        this.PROCESS_WAGER_SERVICE,
        this.WALLET_OPERATIONS_SERVICE,
      ],
    };
  }
}
