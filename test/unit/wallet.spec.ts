import { expect, test } from 'bun:test';
import { Wallet } from '../../src/module/domains/wallet';
import { Money } from '../../src/module/domains/money';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
test('wallet prevents negative balance and increments version only on change', () => {
  const wallet = Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: brl('100') });
  wallet.debit(brl('80'));
  expect(wallet.balance.toString()).toBe('20.00');
  expect(wallet.version).toBe(2);
  expect(() => wallet.debit(brl('80'))).toThrow('INSUFFICIENT_FUNDS');
  wallet.credit(brl('0'));
  expect(wallet.version).toBe(2);
  expect(wallet.balance.toString()).toBe('20.00');
});
