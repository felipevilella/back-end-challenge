import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/module/domains/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('exact decimal arithmetic and immutable values', () => {
    const first = brl('0.10');
    expect(first.add(brl('0.20')).toString()).toBe('0.30');
    expect(first.toString()).toBe('0.10');
    expect(brl('1').toJSON().amount).toBe('1.00');
    expect(brl('1').subtract(brl('2')).toString()).toBe('-1.00');
  });
  test.each(['NaN', 'Infinity', '1e2', '', '1.001', '-1.00', ' 1.00', '1000000000000000000'])(
    'rejects %s',
    (value) => {
      expect(() => brl(value)).toThrow();
    },
  );
  test('rejects numeric amounts at runtime', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(
      'INVALID_MONEY_AMOUNT',
    );
  });
  test('rejects currency conflicts', () => {
    expect(() => brl('1').add(Money.from({ amount: '1', currency: 'USD' }))).toThrow(
      'CURRENCY_MISMATCH',
    );
  });
});
