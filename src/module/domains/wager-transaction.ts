import { Money } from './money';
import { DomainError } from './domain-error';

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export type TransactionKind = WagerKind | 'OPENING';

export type TransactionStatus =
  'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string;
}

export interface TransactionState {
  id: string;
  command: WagerCommand;
  status: TransactionStatus;
  referenceTransactionId?: string;
  failureCode?: string;
}

export class WagerTransaction {
  private constructor(private readonly state: TransactionState) {}

  static create(id: string, command: WagerCommand): WagerTransaction {
    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(command.kind)) {
      throw new DomainError('INVALID_TRANSACTION_KIND', 400);
    }

    const money = Money.from(command.money);
    if (command.kind === 'LOSS' ? !money.isZero() : !money.isPositive()) {
      throw new DomainError('INVALID_OPERATION_AMOUNT', 400);
    }

    if (['REFUND', 'ROLLBACK'].includes(command.kind) && !command.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_REQUIRED', 400);
    }

    if (command.kind === 'BET' && command.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_NOT_ALLOWED', 400);
    }

    return new WagerTransaction({ id, command: structuredClone(command), status: 'PENDING' });
  }

  static rehydrate(state: TransactionState): WagerTransaction {
    return new WagerTransaction(structuredClone(state));
  }

  get id(): string {
    return this.state.id;
  }

  get status(): TransactionStatus {
    return this.state.status;
  }

  get failureCode(): string | undefined {
    return this.state.failureCode;
  }

  isTerminal(): boolean {
    return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status);
  }

  private assertMutable(): void {
    if (this.isTerminal()) {
      throw new Error('INVALID_TRANSACTION_STATE');
    }
  }

  markPendingReference(): void {
    this.assertMutable();
    this.state.status = 'PENDING_REFERENCE';
  }

  markProcessed(referenceTransactionId?: string): void {
    this.assertMutable();
    this.state.referenceTransactionId = referenceTransactionId;
    this.state.status = 'PROCESSED';
  }

  reject(code: string): void {
    this.assertMutable();
    this.state.status = 'REJECTED';
    this.state.failureCode = code;
  }

  fail(code: string): void {
    this.assertMutable();
    this.state.status = 'FAILED';
    this.state.failureCode = code;
  }
}

export interface ReferenceOperation {
  id: string;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  currency: string;
  amount: string;
  kind: TransactionKind;
  status: TransactionStatus;
  direction?: LedgerDirection;
}

export function directionFor(
  command: WagerCommand,
  reference?: ReferenceOperation,
): LedgerDirection | undefined {
  if (command.kind === 'LOSS') {
    return undefined;
  }

  if (command.kind === 'BET') {
    return 'DEBIT';
  }

  if (command.kind === 'ROLLBACK') {
    if (!reference?.direction) {
      throw new Error('MISSING_REFERENCE_DIRECTION');
    }

    return reference.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';
  }

  return 'CREDIT';
}

export function validateReference(command: WagerCommand, reference: ReferenceOperation): void {
  if (
    reference.providerId !== command.providerId ||
    reference.playerId !== command.playerId ||
    reference.walletId !== command.walletId ||
    reference.roundId !== command.roundId ||
    reference.currency !== command.money.currency
  ) {
    throw new DomainError('REFERENCE_CONTEXT_MISMATCH');
  }

  if (reference.status !== 'PROCESSED') {
    throw new DomainError('REFERENCE_NOT_PROCESSED');
  }

  const allowed = command.kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
  if (!allowed.includes(reference.kind)) {
    throw new DomainError('INVALID_REFERENCE_KIND');
  }

  if (
    ['REFUND', 'ROLLBACK'].includes(command.kind) &&
    !Money.from(command.money).equals(
      Money.from({ amount: reference.amount, currency: reference.currency }),
    )
  ) {
    throw new DomainError('REFERENCE_AMOUNT_MISMATCH');
  }
}
