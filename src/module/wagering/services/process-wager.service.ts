import { randomUUID } from 'node:crypto';
import { Money } from '../../domains/money';
import { payloadHash } from '../../domains/canonical-payload';
import { DomainError } from '../../domains/domain-error';
import { type WagerCommand, WagerTransaction } from '../../domains/wager-transaction';
import type {
  IFinancialRepository,
  ProcessingContext,
} from '../../../repositories/financial.repository.interface';

interface Observer {
  increment(name: string, labels?: string): void;
  observeLatency(seconds: number): void;
  log(event: string, context: Record<string, unknown>): void;
}

export class ProcessWagerService {
  constructor(
    private readonly financial: IFinancialRepository,
    private readonly observer?: Observer,
  ) {}

  async execute(command: WagerCommand, context: ProcessingContext) {
    if (!command.idempotencyKey?.trim() || command.idempotencyKey.length > 256) {
      throw new DomainError('INVALID_IDEMPOTENCY_KEY', 400);
    }

    let money;
    try {
      money = Money.from(command.money).toJSON();
    } catch {
      throw new DomainError('INVALID_MONEY', 400);
    }

    const normalized = { ...command, money };
    WagerTransaction.create(randomUUID(), normalized);
    const { idempotencyKey: _, ...business } = normalized;
    const start = performance.now();
    try {
      const result = await this.financial.process(normalized, payloadHash(business), context);
      this.observer?.increment('transactions_total', `status="${result.status}"`);
      if (result.idempotentReplay) {
        this.observer?.increment('duplicates_total');
      }

      this.observer?.log('transaction_result', {
        correlationId: context.correlationId,
        messageId: context.inbox?.messageId,
        transactionId: result.transactionId,
        walletId: command.walletId,
        providerId: command.providerId,
        status: result.status,
      });

      return result;
    } catch (error) {
      const code = (
        error as {
          code?: string;
        }
      ).code;
      if (['40001', '40P01', '55P03'].includes(code ?? '')) {
        this.observer?.increment('lock_conflicts_total');
      }

      if (error instanceof DomainError && error.httpStatus === 409) {
        this.observer?.increment('idempotency_conflicts_total');
      }

      throw error;
    } finally {
      this.observer?.observeLatency((performance.now() - start) / 1000);
    }
  }
}
