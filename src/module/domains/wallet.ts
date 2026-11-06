import { Money } from './money';

export interface WalletState {
  id: string; playerId: string; currency: string; balance: Money;
  version: number; createdAt: Date; updatedAt: Date;
}
export class Wallet {
  private constructor(private readonly state: WalletState) {}
  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (props.initialBalance.isNegative()) throw new Error('NEGATIVE_INITIAL_BALANCE');
    const now = new Date();
    return new Wallet({ id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1, createdAt: now, updatedAt: now });
  }
  static rehydrate(state: WalletState): Wallet { return new Wallet({ ...state }); }
  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get currency(): string { return this.state.currency; }
  get balance(): Money { return this.state.balance; }
  get version(): number { return this.state.version; }
  debit(money: Money): void {
    if (money.isNegative()) throw new Error('INVALID_MOVEMENT');
    if (this.balance.isLessThan(money)) throw new Error('INSUFFICIENT_FUNDS');
    this.change(this.balance.subtract(money));
  }
  credit(money: Money): void {
    if (money.isNegative()) throw new Error('INVALID_MOVEMENT');
    this.change(this.balance.add(money));
  }
  private change(balance: Money): void {
    if (!this.balance.equals(balance)) {
      this.state.balance = balance;
      this.state.version++;
      this.state.updatedAt = new Date();
    }
  }
}
