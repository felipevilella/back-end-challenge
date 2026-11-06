import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/module/domains/money';
import { WalletLedgerEntry } from '../../src/module/domains/ledger-entry';
import {
  directionFor,
  type ReferenceOperation,
  validateReference,
  type WagerCommand,
  WagerTransaction,
} from '../../src/module/domains/wager-transaction';
import { ProcessWagerService } from '../../src/module/wagering/services/process-wager.service';
import { canonicalJSON, payloadHash } from '../../src/module/domains/canonical-payload';
import type { IFinancialRepository } from '../../src/repositories/financial.repository.interface';

const command: WagerCommand = {
  providerId: 'p',
  externalTransactionId: 'bet',
  idempotencyKey: 'p:bet',
  playerId: 'player',
  walletId: 'wallet',
  roundId: 'r',
  gameId: 'g',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
};

const reference: ReferenceOperation = {
  id: 'ref',
  providerId: 'p',
  playerId: 'player',
  walletId: 'wallet',
  roundId: 'r',
  currency: 'BRL',
  amount: '10.00',
  kind: 'BET',
  status: 'PROCESSED',
  direction: 'DEBIT',
};

describe('wager rules', () => {
  test('all terminal states forbid transitions', () => {
    for (const terminal of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
      const tx = WagerTransaction.rehydrate({ id: 'id', command, status: terminal });
      expect(() => tx.markProcessed()).toThrow('INVALID_TRANSACTION_STATE');
      expect(() => tx.markPendingReference()).toThrow();
      expect(() => tx.reject('reason')).toThrow();
      expect(() => tx.fail('reason')).toThrow();
    }
  });
  test('pending reference can become terminal', () => {
    const tx = WagerTransaction.create('id', command);
    tx.markPendingReference();
    tx.markProcessed('ref');
    expect(tx.status).toBe('PROCESSED');
  });
  test('positive amounts for financial operations, zero for LOSS', () => {
    expect(() =>
      WagerTransaction.create('id', { ...command, money: { ...command.money, amount: '0' } }),
    ).toThrow();
    expect(() => WagerTransaction.create('id', { ...command, kind: 'LOSS' })).toThrow();
    expect(
      WagerTransaction.create('id', {
        ...command,
        kind: 'LOSS',
        money: { ...command.money, amount: '0' },
      }).status,
    ).toBe('PENDING');
  });
  test('refund requires reference and exact amount', () => {
    expect(() => WagerTransaction.create('id', { ...command, kind: 'REFUND' })).toThrow(
      'REFERENCE_REQUIRED',
    );
    const refund = { ...command, kind: 'REFUND' as const, referenceExternalTransactionId: 'bet' };
    expect(() => validateReference(refund, reference)).not.toThrow();
    expect(() =>
      validateReference({ ...refund, money: { ...command.money, amount: '9' } }, reference),
    ).toThrow('REFERENCE_AMOUNT_MISMATCH');
  });
  test('references must match provider, player, wallet, currency and round', () => {
    for (const field of ['providerId', 'playerId', 'walletId', 'currency', 'roundId'] as const) {
      expect(() =>
        validateReference({ ...command, kind: 'WIN' }, { ...reference, [field]: 'different' }),
      ).toThrow('REFERENCE_CONTEXT_MISMATCH');
    }
    expect(() =>
      validateReference({ ...command, kind: 'REFUND' }, { ...reference, kind: 'WIN' }),
    ).toThrow('INVALID_REFERENCE_KIND');
  });
  test('directions and inverse directions', () => {
    expect(directionFor(command)).toBe('DEBIT');
    expect(directionFor({ ...command, kind: 'WIN' })).toBe('CREDIT');
    expect(directionFor({ ...command, kind: 'LOSS' })).toBeUndefined();
    expect(directionFor({ ...command, kind: 'REFUND' }, reference)).toBe('CREDIT');
    expect(directionFor({ ...command, kind: 'ROLLBACK' }, reference)).toBe('CREDIT');
    expect(
      directionFor(
        { ...command, kind: 'ROLLBACK' },
        { ...reference, direction: 'CREDIT', kind: 'WIN' },
      ),
    ).toBe('DEBIT');
  });
});

test('ledger rejects unbalanced entries', () => {
  const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
  const state = {
    id: 'id',
    walletId: 'w',
    transactionId: 't',
    direction: 'DEBIT' as const,
    money: brl('10'),
    balanceBefore: brl('100'),
    balanceAfter: brl('90'),
    walletVersion: 2,
    createdAt: new Date(),
  };
  expect(WalletLedgerEntry.create(state).isBalanced()).toBe(true);
  expect(() => WalletLedgerEntry.create({ ...state, balanceAfter: brl('91') })).toThrow(
    'INVALID_LEDGER_ENTRY',
  );
});

test('canonical hash is independent of insertion order and transport metadata', async () => {
  expect(canonicalJSON({ z: 1, a: { y: '2', b: true } })).toBe('{"a":{"b":true,"y":"2"},"z":1}');
  expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  let savedHash = '';
  const financial = {
    process: async (_command: WagerCommand, hash: string) => {
      savedHash = hash;

      return {
        transactionId: 'id',
        status: 'PROCESSED',
        balance: command.money,
        idempotentReplay: false,
      };
    },
  } as unknown as IFinancialRepository;
  const service = new ProcessWagerService(financial);
  await service.execute(command, { correlationId: 'a' });
  const first = savedHash;
  await service.execute(
    { ...command, idempotencyKey: 'other', money: { ...command.money, amount: '10' } },
    { correlationId: 'b' },
  );
  expect(savedHash).toBe(first);
});
