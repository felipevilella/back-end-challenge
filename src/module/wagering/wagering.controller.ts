import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UseCaseProxy } from '../../infra/usecase-proxy/usecase-proxy';
import { UseCaseProxyModule } from '../../infra/usecase-proxy/usecase-proxy.module';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { WagerDto } from './dto/wager.dto';
import { ProcessWagerService } from './services/process-wager.service';
import { WalletOperationsService } from './services/wallet-operations.service';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(UseCaseProxyModule.PROCESS_WAGER_SERVICE)
    private readonly processWager: UseCaseProxy<ProcessWagerService>,
    @Inject(UseCaseProxyModule.WALLET_OPERATIONS_SERVICE)
    private readonly queries: UseCaseProxy<WalletOperationsService>,
  ) {}

  @Post('wagering/transactions')
  @HttpCode(200)
  async submit(
    @Body()
    dto: WagerDto,
    @Headers('idempotency-key')
    key: string,
    @Headers('x-correlation-id')
    correlation: string | undefined,
    @Res({ passthrough: true })
    response: {
      status(code: number): unknown;
    },
  ) {
    const result = await this.processWager
      .getInstance()
      .execute(
        { ...dto, idempotencyKey: key },
        { correlationId: correlation?.slice(0, 256) || randomUUID() },
      );
    response.status(
      result.status === 'PENDING_REFERENCE' || result.status === 'PENDING'
        ? 202
        : result.status === 'REJECTED'
          ? 422
          : result.status === 'FAILED'
            ? 500
            : 200,
    );

    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async find(
    @Param('transactionId', ParseUUIDPipe)
    id: string,
  ) {
    const result = await this.queries.getInstance().find(id);
    if (!result) {
      throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    }

    return result;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findExternal(
    @Param('providerId')
    provider: string,
    @Param('externalTransactionId')
    external: string,
  ) {
    const result = await this.queries.getInstance().findExternal(provider, external);
    if (!result) {
      throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    }

    return result;
  }
}
