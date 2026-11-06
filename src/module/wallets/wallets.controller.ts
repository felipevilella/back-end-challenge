import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { UseCaseProxy } from '../../infra/usecase-proxy/usecase-proxy';
import { UseCaseProxyModule } from '../../infra/usecase-proxy/usecase-proxy.module';
import { GetWalletService } from './services/get-wallet.service';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(@Inject(UseCaseProxyModule.GET_WALLET_SERVICE) private readonly getWallet: UseCaseProxy<GetWalletService>) {}
  @Get(':walletId')
  async find(@Param('walletId', ParseUUIDPipe) id: string) {
    const wallet = await this.getWallet.getInstance().execute(id);
    if (!wallet) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    return wallet;
  }
}
