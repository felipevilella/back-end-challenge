import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, MoreThan } from 'typeorm';
import { Money } from '../../module/domains/money';
import type { MoneyProps } from '../../module/domains/money';
import { Wallet } from '../../module/domains/wallet';
import { DomainError } from '../../module/domains/domain-error';
import { WalletLedgerEntry } from '../../module/domains/ledger-entry';
import {
  directionFor,
  validateReference,
  WagerTransaction,
} from '../../module/domains/wager-transaction';
import type {
  LedgerDirection,
  ReferenceOperation,
  WagerCommand,
} from '../../module/domains/wager-transaction';
import {
  IntegrationEvent,
  WalletBalanceChanged,
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../module/domains/events/integration-event';
import type { EventContext } from '../../module/domains/events/integration-event';
import type {
  IFinancialRepository,
  LedgerEntryView,
  LedgerPage,
  PendingReference,
  ProcessingContext,
  ReconciliationResult,
  TransactionView,
  WagerResult,
  WalletView,
} from '../../repositories/financial.repository.interface';
import { payloadHash } from '../../module/domains/canonical-payload';
import { WalletMapper } from '../../module/wallets/mapper/wallet.mapper';
import { InboxMessageEntity } from '../entities/inbox-message.entity';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';
import { WalletLedgerEntity } from '../entities/wallet-ledger.entity';
import { WalletEntity } from '../entities/wallet.entity';

const MAX_REFERENCE_ATTEMPTS = 20;

const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_REFERENCE_BACKOFF_SECONDS = 300;

interface ReferenceResolution {
  reference?: ReferenceOperation;
  pending: boolean;
  failureCode?: string;
}

interface ReconciliationRow {
  balance: string;
  currency: string;
  calculated: string;
  count: string;
}

@Injectable()
export class FinancialRepository implements IFinancialRepository {
  constructor(private readonly database: DataSource) {}

  async process(
    command: WagerCommand,
    hash: string,
    context: ProcessingContext,
  ): Promise<WagerResult> {
    return this.store(command, hash, context);
  }

  async recordFailure(
    command: WagerCommand,
    hash: string,
    context: ProcessingContext,
  ): Promise<WagerResult> {
    return this.store(command, hash, context, 'INFRASTRUCTURE_RETRY_EXHAUSTED');
  }

  private async store(
    command: WagerCommand,
    hash: string,
    context: ProcessingContext,
    infrastructureFailure?: string,
  ): Promise<WagerResult> {
    return this.database.transaction(async (manager) => {
      const wallet = await this.lockWallet(manager, command.walletId);
      await this.receiveInbox(manager, context);
      const transaction = await this.insertTransaction(manager, command, hash, context);
      if (!transaction) {
        const replay = await this.findReplay(manager, command, hash);
        await this.finishInbox(manager, context);

        return replay;
      }

      const result = await this.apply(manager, transaction, wallet, context, infrastructureFailure);
      await this.finishInbox(manager, context);

      return result;
    });
  }

  private async lockWallet(manager: EntityManager, id: string): Promise<WalletEntity> {
    const wallet = await manager.getRepository(WalletEntity).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!wallet) {
      throw new DomainError('WALLET_NOT_FOUND', 404);
    }

    return wallet;
  }

  private async receiveInbox(manager: EntityManager, context: ProcessingContext): Promise<void> {
    if (!context.inbox) {
      return;
    }

    const { consumerName, messageId, payloadHash: hash } = context.inbox;
    const inbox = manager.getRepository(InboxMessageEntity);
    await inbox
      .createQueryBuilder()
      .insert()
      .values({ consumerName, messageId, payloadHash: hash })
      .orIgnore()
      .execute();
    const existing = await inbox.findOneByOrFail({ consumerName, messageId });
    if (existing.payloadHash !== hash) {
      throw new DomainError('INBOX_PAYLOAD_CONFLICT', 409);
    }
  }

  private async finishInbox(manager: EntityManager, context: ProcessingContext): Promise<void> {
    if (!context.inbox) {
      return;
    }

    const { consumerName, messageId } = context.inbox;
    await manager
      .getRepository(InboxMessageEntity)
      .update(
        { consumerName, messageId, processedAt: IsNull() },
        { processedAt: () => 'CURRENT_TIMESTAMP' },
      );
  }

  private async insertTransaction(
    manager: EntityManager,
    command: WagerCommand,
    hash: string,
    context: ProcessingContext,
  ): Promise<WagerTransactionEntity | null> {
    const transactions = manager.getRepository(WagerTransactionEntity);
    const id = randomUUID();
    const insertion = await transactions
      .createQueryBuilder()
      .insert()
      .values({
        id,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: hash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        amount: command.money.amount,
        currency: command.money.currency,
        referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
        status: 'PENDING',
        correlationId: context.correlationId,
      })
      .orIgnore()
      .returning('id')
      .execute();
    const inserted = insertion.raw as Array<{
      id: string;
    }>;
    if (inserted.length === 0) {
      return null;
    }

    return transactions.findOneByOrFail({ id });
  }

  private async findReplay(
    manager: EntityManager,
    command: WagerCommand,
    hash: string,
  ): Promise<WagerResult> {
    const existing = await manager.getRepository(WagerTransactionEntity).findBy([
      { idempotencyKey: command.idempotencyKey },
      {
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
      },
    ]);
    const transaction = existing[0];
    if (
      existing.length !== 1 ||
      !transaction ||
      transaction.idempotencyKey !== command.idempotencyKey ||
      transaction.payloadHash !== hash
    ) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
    }

    if (!transaction.result) {
      throw new Error('PERSISTED_TRANSACTION_RESULT_MISSING');
    }

    return {
      ...transaction.result,
      idempotentReplay: true,
    };
  }

  private toCommand(transaction: WagerTransactionEntity): WagerCommand {
    if (transaction.kind === 'OPENING') {
      throw new Error('OPENING_CANNOT_BE_REPROCESSED');
    }

    return {
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: {
        amount: transaction.amount,
        currency: transaction.currency,
      },
      ...(transaction.referenceExternalTransactionId
        ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
        : {}),
    };
  }

  private async resolveReference(
    manager: EntityManager,
    transactionId: string,
    command: WagerCommand,
  ): Promise<ReferenceResolution> {
    if (!command.referenceExternalTransactionId) {
      return { pending: false };
    }

    const transaction = await manager.getRepository(WagerTransactionEntity).findOneBy({
      providerId: command.providerId,
      externalTransactionId: command.referenceExternalTransactionId,
    });
    if (!transaction) {
      return { pending: true };
    }

    if (transaction.id === transactionId) {
      return { pending: false, failureCode: 'SELF_REFERENCE' };
    }

    const entry = await manager.getRepository(WalletLedgerEntity).findOneBy({
      transactionId: transaction.id,
    });
    const reference: ReferenceOperation = {
      id: transaction.id,
      providerId: transaction.providerId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      currency: transaction.currency,
      amount: transaction.amount,
      kind: transaction.kind,
      status: transaction.status,
      direction: entry?.direction,
    };
    try {
      // Validate context before deciding whether the referenced operation can be retried.
      validateReference(command, reference);

      return { reference, pending: false };
    } catch (error) {
      if (!(error instanceof DomainError)) {
        throw error;
      }

      if (
        error.code === 'REFERENCE_NOT_PROCESSED' &&
        ['PENDING', 'PENDING_REFERENCE'].includes(reference.status)
      ) {
        return { reference, pending: true };
      }

      return { reference, pending: false, failureCode: error.code };
    }
  }

  private async apply(
    manager: EntityManager,
    persisted: WagerTransactionEntity,
    walletEntity: WalletEntity,
    context: ProcessingContext,
    infrastructureFailure?: string,
  ): Promise<WagerResult> {
    const command = this.toCommand(persisted);
    const transaction = WagerTransaction.rehydrate({
      id: persisted.id,
      command,
      status: persisted.status,
    });
    const wallet = WalletMapper.toDomain(walletEntity);
    const before = wallet.balance;
    const eventContext: EventContext = {
      aggregateId: wallet.id,
      correlationId: context.correlationId,
      causationId: context.causationId ?? persisted.id,
    };
    let failure = infrastructureFailure;
    let reference: ReferenceOperation | undefined;
    if (!failure && command.playerId !== wallet.playerId) {
      failure = 'PLAYER_MISMATCH';
    } else if (!failure && command.money.currency !== wallet.currency) {
      failure = 'CURRENCY_MISMATCH';
    }

    if (!failure) {
      const resolution = await this.resolveReference(manager, persisted.id, command);
      reference = resolution.reference;
      failure = resolution.failureCode;
      if (resolution.pending && !failure) {
        if (this.referenceExpired(persisted)) {
          failure = 'REFERENCE_EXPIRED';
        } else {
          return this.deferReference(manager, persisted, transaction, before, eventContext);
        }
      }
    }

    if (!failure && reference && ['REFUND', 'ROLLBACK'].includes(command.kind)) {
      const alreadyReversed = await manager.getRepository(WagerTransactionEntity).existsBy({
        referenceTransactionId: reference.id,
        kind: command.kind,
        status: 'PROCESSED',
      });
      if (alreadyReversed) {
        failure = 'REFERENCE_ALREADY_REVERSED';
      }
    }

    const direction = failure ? undefined : directionFor(command, reference);
    const money = Money.from(command.money);
    if (!failure && direction === 'DEBIT' && before.isLessThan(money)) {
      failure = command.kind === 'BET' ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS';
    }

    if (!failure && direction === 'CREDIT') {
      try {
        Money.from(before.add(money).toJSON());
      } catch {
        failure = 'BALANCE_LIMIT_EXCEEDED';
      }
    }

    if (infrastructureFailure) {
      transaction.fail(infrastructureFailure);
    } else if (failure) {
      transaction.reject(failure);
    } else {
      if (direction) {
        await this.applyMovement(manager, wallet, persisted.id, direction, money, eventContext);
      }

      transaction.markProcessed(reference?.id);
    }

    const result: WagerResult = {
      transactionId: persisted.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      idempotentReplay: false,
    };
    await manager.getRepository(WagerTransactionEntity).update(persisted.id, {
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      referenceTransactionId: reference?.id ?? null,
      result,
      processedAt: () => 'CURRENT_TIMESTAMP',
      nextAttemptAt: null,
    });
    const eventData = {
      transactionId: persisted.id,
      walletId: wallet.id,
      providerId: command.providerId,
      kind: command.kind,
      ...(failure ? { failureCode: failure } : {}),
    };
    const event = infrastructureFailure
      ? WagerTransactionFailed.create(randomUUID(), eventContext, eventData)
      : failure
        ? WagerTransactionRejected.create(randomUUID(), eventContext, eventData)
        : WagerTransactionProcessed.create(randomUUID(), eventContext, eventData);
    await this.enqueue(manager, event);

    return result;
  }

  private referenceExpired(transaction: WagerTransactionEntity): boolean {
    return (
      transaction.attempts >= MAX_REFERENCE_ATTEMPTS ||
      Date.now() - transaction.createdAt.getTime() >= REFERENCE_TTL_MS
    );
  }

  private async deferReference(
    manager: EntityManager,
    persisted: WagerTransactionEntity,
    transaction: WagerTransaction,
    balance: Money,
    context: EventContext,
  ): Promise<WagerResult> {
    transaction.markPendingReference();
    const result: WagerResult = {
      transactionId: transaction.id,
      status: transaction.status,
      balance: balance.toJSON(),
      idempotentReplay: false,
    };
    const delay = Math.min(MAX_REFERENCE_BACKOFF_SECONDS, 2 ** persisted.attempts);
    await manager
      .getRepository(WagerTransactionEntity)
      .createQueryBuilder()
      .update()
      .set({
        status: 'PENDING_REFERENCE',
        result,
        attempts: () => 'attempts + 1',
        nextAttemptAt: () => "CURRENT_TIMESTAMP + (:delay * INTERVAL '1 second')",
      })
      .where({ id: persisted.id })
      .setParameter('delay', delay)
      .execute();
    if (persisted.status !== 'PENDING_REFERENCE') {
      await this.enqueue(
        manager,
        WagerTransactionPendingReference.create(randomUUID(), context, {
          transactionId: persisted.id,
          walletId: persisted.walletId,
          referenceExternalTransactionId: persisted.referenceExternalTransactionId,
        }),
      );
    }

    return result;
  }

  private async applyMovement(
    manager: EntityManager,
    wallet: Wallet,
    transactionId: string,
    direction: LedgerDirection,
    money: Money,
    context: EventContext,
  ): Promise<void> {
    const before = wallet.balance;
    if (direction === 'DEBIT') {
      wallet.debit(money);
    } else {
      wallet.credit(money);
    }

    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: wallet.balance,
      walletVersion: wallet.version,
      createdAt: new Date(),
    });
    await manager.getRepository(WalletEntity).update(wallet.id, {
      balance: wallet.balance.toString(),
      version: wallet.version,
      updatedAt: () => 'CURRENT_TIMESTAMP',
    });
    await this.insertLedgerEntry(manager, entry);
    await this.enqueue(
      manager,
      WalletBalanceChanged.create(randomUUID(), context, {
        walletId: wallet.id,
        transactionId,
        direction,
        money: money.toJSON(),
        balanceBefore: before.toJSON(),
        balanceAfter: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }

  private async insertLedgerEntry(manager: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    const state = entry.state;
    await manager.getRepository(WalletLedgerEntity).insert({
      id: state.id,
      walletId: state.walletId,
      transactionId: state.transactionId,
      direction: state.direction,
      amount: state.money.toString(),
      currency: state.money.currency,
      balanceBefore: state.balanceBefore.toString(),
      balanceAfter: state.balanceAfter.toString(),
      walletVersion: state.walletVersion,
      createdAt: state.createdAt,
    });
  }

  private async enqueue(
    manager: EntityManager,
    event: IntegrationEvent<Record<string, unknown>>,
  ): Promise<void> {
    const envelope = event.toJSON();
    await manager.getRepository(OutboxMessageEntity).insert({
      id: envelope.eventId,
      aggregateId: envelope.aggregateId,
      eventType: envelope.eventType,
      payload: envelope,
      occurredAt: event.occurredAt,
    });
  }

  async findPendingReferences(limit = 25): Promise<PendingReference[]> {
    return this.database
      .getRepository(WagerTransactionEntity)
      .createQueryBuilder('transaction')
      .select([
        'transaction.id',
        'transaction.walletId',
        'transaction.providerId',
        'transaction.correlationId',
      ])
      .where('transaction.status = :status', { status: 'PENDING_REFERENCE' })
      .andWhere('transaction.nextAttemptAt <= CURRENT_TIMESTAMP')
      .orderBy('transaction.nextAttemptAt', 'ASC')
      .addOrderBy('transaction.id', 'ASC')
      .take(limit)
      .getMany();
  }

  async resume(id: string): Promise<WagerResult | undefined> {
    const candidate = await this.database.getRepository(WagerTransactionEntity).findOneBy({ id });
    if (!candidate) {
      return undefined;
    }

    return this.database.transaction(async (manager) => {
      const wallet = await this.lockWallet(manager, candidate.walletId);
      const transaction = await manager
        .getRepository(WagerTransactionEntity)
        .createQueryBuilder('transaction')
        .where('transaction.id = :id', { id })
        .andWhere('transaction.status = :status', { status: 'PENDING_REFERENCE' })
        .andWhere('transaction.nextAttemptAt <= CURRENT_TIMESTAMP')
        .setLock('pessimistic_write')
        .getOne();
      if (!transaction) {
        return undefined;
      }

      return this.apply(manager, transaction, wallet, {
        correlationId: transaction.correlationId,
        causationId: transaction.id,
      });
    });
  }

  async createWallet(
    playerId: string,
    initialBalance: MoneyProps,
    context: ProcessingContext,
  ): Promise<WalletView> {
    const money = Money.from(initialBalance);
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId,
      initialBalance: money,
    });

    return this.database.transaction(async (manager) => {
      const insertion = await manager
        .getRepository(WalletEntity)
        .createQueryBuilder()
        .insert()
        .values({
          id: wallet.id,
          playerId,
          currency: money.currency,
          balance: money.toString(),
          version: 1,
        })
        .orIgnore()
        .returning('id')
        .execute();
      const inserted = insertion.raw as Array<{
        id: string;
      }>;
      if (inserted.length === 0) {
        throw new DomainError('WALLET_ALREADY_EXISTS', 409);
      }

      if (money.isPositive()) {
        await this.createOpening(manager, wallet, money, context);
      }

      return WalletMapper.toDTO(wallet);
    });
  }

  private async createOpening(
    manager: EntityManager,
    wallet: Wallet,
    money: Money,
    context: ProcessingContext,
  ): Promise<void> {
    const id = randomUUID();
    const result: WagerResult = {
      transactionId: id,
      status: 'PROCESSED',
      balance: money.toJSON(),
      idempotentReplay: false,
    };
    await manager.getRepository(WagerTransactionEntity).insert({
      id,
      providerId: '__internal__',
      externalTransactionId: id,
      idempotencyKey: `opening:${id}`,
      payloadHash: payloadHash({ playerId: wallet.playerId, initialBalance: money.toJSON() }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: '__opening__',
      gameId: '__opening__',
      kind: 'OPENING',
      amount: money.toString(),
      currency: money.currency,
      status: 'PROCESSED',
      result,
      processedAt: () => 'CURRENT_TIMESTAMP',
      correlationId: context.correlationId,
    });
    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: id,
      direction: 'CREDIT',
      money,
      balanceBefore: Money.zero(money.currency),
      balanceAfter: money,
      walletVersion: 1,
      createdAt: new Date(),
    });
    const eventContext: EventContext = {
      aggregateId: wallet.id,
      correlationId: context.correlationId,
      causationId: id,
    };
    await this.insertLedgerEntry(manager, entry);
    await this.enqueue(
      manager,
      WalletBalanceChanged.create(randomUUID(), eventContext, {
        walletId: wallet.id,
        transactionId: id,
        direction: 'CREDIT',
        money: money.toJSON(),
        balanceBefore: Money.zero(money.currency).toJSON(),
        balanceAfter: money.toJSON(),
        walletVersion: 1,
      }),
    );
    await this.enqueue(
      manager,
      WagerTransactionProcessed.create(randomUUID(), eventContext, {
        transactionId: id,
        walletId: wallet.id,
        kind: 'OPENING',
      }),
    );
  }

  async findTransaction(id: string): Promise<TransactionView | null> {
    const transaction = await this.database.getRepository(WagerTransactionEntity).findOneBy({ id });

    return transaction ? this.toTransactionView(transaction) : null;
  }

  async findExternal(providerId: string, externalId: string): Promise<TransactionView | null> {
    const transaction = await this.database.getRepository(WagerTransactionEntity).findOneBy({
      providerId,
      externalTransactionId: externalId,
    });

    return transaction ? this.toTransactionView(transaction) : null;
  }

  private toTransactionView(transaction: WagerTransactionEntity): TransactionView {
    if (!transaction.result) {
      throw new Error('PERSISTED_TRANSACTION_RESULT_MISSING');
    }

    return {
      ...transaction.result,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      kind: transaction.kind,
      money: {
        amount: transaction.amount,
        currency: transaction.currency,
      },
      referenceTransactionId: transaction.referenceTransactionId,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      createdAt: transaction.createdAt,
    };
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const walletExists = await this.database.getRepository(WalletEntity).existsBy({ id: walletId });
    if (!walletExists) {
      throw new DomainError('WALLET_NOT_FOUND', 404);
    }

    const version = this.decodeCursor(walletId, cursor);
    const entries = await this.database.getRepository(WalletLedgerEntity).find({
      where: {
        walletId,
        walletVersion: MoreThan(version),
      },
      order: { walletVersion: 'ASC' },
      take: limit + 1,
    });
    const hasMore = entries.length > limit;
    const page = entries.slice(0, limit);
    const lastEntry = page.at(-1);

    return {
      entries: page.map((entry) => this.toLedgerView(entry)),
      nextCursor:
        hasMore && lastEntry
          ? Buffer.from(JSON.stringify({ walletId, version: lastEntry.walletVersion })).toString(
              'base64url',
            )
          : null,
    };
  }

  private decodeCursor(walletId: string, cursor: string | undefined): number {
    if (!cursor) {
      return 0;
    }

    try {
      const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        !('walletId' in decoded) ||
        !('version' in decoded) ||
        decoded.walletId !== walletId ||
        typeof decoded.version !== 'number' ||
        !Number.isSafeInteger(decoded.version) ||
        decoded.version < 1
      ) {
        throw new Error('INVALID_CURSOR');
      }

      return decoded.version;
    } catch {
      throw new DomainError('INVALID_CURSOR', 400);
    }
  }

  private toLedgerView(entry: WalletLedgerEntity): LedgerEntryView {
    return {
      id: entry.id,
      wallet_id: entry.walletId,
      transaction_id: entry.transactionId,
      direction: entry.direction,
      amount: entry.amount,
      currency: entry.currency,
      balance_before: entry.balanceBefore,
      balance_after: entry.balanceAfter,
      wallet_version: entry.walletVersion,
      created_at: entry.createdAt,
    };
  }

  async reconcile(walletId: string): Promise<ReconciliationResult> {
    // Aggregate both balances in one SQL statement to preserve the same MVCC snapshot.
    const row = await this.database
      .getRepository(WalletEntity)
      .createQueryBuilder('wallet')
      .leftJoin(WalletLedgerEntity, 'ledger', 'ledger.walletId = wallet.id')
      .select('wallet.balance', 'balance')
      .addSelect('wallet.currency', 'currency')
      .addSelect(
        "COALESCE(SUM(CASE ledger.direction WHEN 'CREDIT' THEN ledger.amount ELSE -ledger.amount END), 0)::text",
        'calculated',
      )
      .addSelect('COUNT(ledger.id)::text', 'count')
      .where('wallet.id = :walletId', { walletId })
      .groupBy('wallet.id')
      .getRawOne<ReconciliationRow>();
    if (!row) {
      throw new DomainError('WALLET_NOT_FOUND', 404);
    }

    const stored = Money.from({ amount: row.balance, currency: row.currency });
    const calculated = Money.from({ amount: row.calculated, currency: row.currency });

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(),
      consistent: stored.equals(calculated),
      checkedEntries: Number(row.count),
    };
  }
}
