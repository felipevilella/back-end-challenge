import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UseCaseProxy } from '../../infra/usecase-proxy/usecase-proxy';
import { UseCaseProxyModule } from '../../infra/usecase-proxy/usecase-proxy.module';
import { GetWalletService } from './services/get-wallet.service';
import { WalletOperationsService } from '../wagering/services/wallet-operations.service';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { DomainError } from '../domains/domain-error';
import { Telemetry } from '../../infra/observability/telemetry';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(UseCaseProxyModule.GET_WALLET_SERVICE)
    private readonly getWallet: UseCaseProxy<GetWalletService>,
    @Inject(UseCaseProxyModule.WALLET_OPERATIONS_SERVICE)
    private readonly operations: UseCaseProxy<WalletOperationsService>,
    private readonly telemetry: Telemetry,
  ) {}

  @Post()
  create(
    @Body()
    dto: CreateWalletDto,
    @Headers('x-correlation-id')
    correlation?: string,
  ) {
    return this.operations.getInstance().create(dto.playerId, dto.initialBalance, {
      correlationId: correlation?.slice(0, 256) || randomUUID(),
    });
  }

  @Get(':walletId')
  async find(
    @Param('walletId', ParseUUIDPipe)
    id: string,
  ) {
    const wallet = await this.getWallet.getInstance().execute(id);
    if (!wallet) {
      throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    }

    return wallet;
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', ParseUUIDPipe)
    id: string,
    @Query('cursor')
    cursor?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe)
    limit = 50,
  ) {
    if (limit < 1 || limit > 200) {
      throw new DomainError('INVALID_LIMIT', 400);
    }

    return this.operations.getInstance().ledger(id, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(
    @Param('walletId', ParseUUIDPipe)
    id: string,
  ) {
    const result = await this.operations.getInstance().reconcile(id);
    if (!result.consistent) {
      this.telemetry.increment('reconciliation_mismatches_total');
      this.telemetry.log('reconciliation_mismatch', { walletId: id });
    }

    return result;
  }
}
