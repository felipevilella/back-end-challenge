import { Money } from './money';
import type { LedgerDirection } from './wager-transaction';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(readonly state: Readonly<LedgerEntryState>) {}

  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(Object.freeze({ ...state }));
    if (
      !state.money.isPositive() ||
      state.balanceBefore.isNegative() ||
      state.balanceAfter.isNegative() ||
      !entry.isBalanced()
    ) {
      throw new Error('INVALID_LEDGER_ENTRY');
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(Object.freeze({ ...state }));
  }

  isBalanced(): boolean {
    const { direction, balanceBefore, balanceAfter, money } = this.state;

    return (
      direction === 'CREDIT' ? balanceBefore.add(money) : balanceBefore.subtract(money)
    ).equals(balanceAfter);
  }
}
