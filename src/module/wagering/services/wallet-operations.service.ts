import type {
  IFinancialRepository,
  ProcessingContext,
} from '../../../repositories/financial.repository.interface';
import { type MoneyProps, Money } from '../../domains/money';
import { DomainError } from '../../domains/domain-error';

export class WalletOperationsService {
  constructor(private readonly financial: IFinancialRepository) {}

  create(playerId: string, money: MoneyProps, context: ProcessingContext) {
    try {
      Money.from(money);
    } catch {
      throw new DomainError('INVALID_MONEY', 400);
    }

    return this.financial.createWallet(playerId, money, context);
  }

  ledger(walletId: string, cursor: string | undefined, limit: number) {
    return this.financial.ledger(walletId, cursor, limit);
  }

  reconcile(walletId: string) {
    return this.financial.reconcile(walletId);
  }

  find(id: string) {
    return this.financial.findTransaction(id);
  }

  findExternal(provider: string, external: string) {
    return this.financial.findExternal(provider, external);
  }
}
