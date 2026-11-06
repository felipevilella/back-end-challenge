import 'reflect-metadata';
import { persistenceEntities } from '../../src/infra/entities';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InitialWallets1790000000000 } from '../../src/infra/database/typeorm/migrations/1790000000000-initial-wallets';
import { FinancialProcessing1790000001000 } from '../../src/infra/database/typeorm/migrations/1790000001000-financial-processing';
import { FinancialRepository } from '../../src/infra/repositories/financial.repository';
import { OutboxRepository } from '../../src/infra/repositories/outbox.repository';
import { ProcessWagerService } from '../../src/module/wagering/services/process-wager.service';
import type { WagerCommand } from '../../src/module/domains/wager-transaction';

const url = process.env.TEST_DATABASE_URL;
// No fallback to DATABASE_URL: integration tests must explicitly target a test database.
const suite = url ? describe : describe.skip;

suite('PostgreSQL financial integration', () => {
  const db = new DataSource({
    type: 'postgres',
    url,
    entities: persistenceEntities,
    migrations: [InitialWallets1790000000000, FinancialProcessing1790000001000],
    extra: { max: 20 },
  });
  let repository: FinancialRepository;
  let service: ProcessWagerService;
  const ctx = { correlationId: 'integration' };
  beforeAll(async () => {
    await db.initialize();
    await db.runMigrations();
    repository = new FinancialRepository(db);
    service = new ProcessWagerService(repository);
  });
  afterAll(async () => {
    if (db.isInitialized) {
      await db.destroy();
    }
  });
  async function wallet(amount = '100.00') {
    return (await repository.createWallet(randomUUID(), { amount, currency: 'BRL' }, ctx)) as {
      id: string;
      playerId: string;
    };
  }
  function wager(
    w: {
      id: string;
      playerId: string;
    },
    overrides: Partial<WagerCommand> = {},
  ): WagerCommand {
    const external = randomUUID();

    return {
      providerId: 'test',
      externalTransactionId: external,
      idempotencyKey: `test:${external}`,
      walletId: w.id,
      playerId: w.playerId,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    };
  }
  async function invariant(id: string, expected?: string) {
    const result = (await repository.reconcile(id)) as {
      consistent: boolean;
      storedBalance: {
        amount: string;
      };
    };
    expect(result.consistent).toBe(true);
    if (expected) {
      expect(result.storedBalance.amount).toBe(expected);
    }
  }
  test('OPENING is atomic, zero opening has no ledger and wallet uniqueness is enforced', async () => {
    const w = await wallet();
    await invariant(w.id, '100.00');
    const [count] = await db.query('SELECT count(*)::int n FROM wallet_ledger WHERE wallet_id=$1', [
      w.id,
    ]);
    expect(count.n).toBe(1);
    await expect(
      repository.createWallet(w.playerId, { amount: '1', currency: 'BRL' }, ctx),
    ).rejects.toThrow('WALLET_ALREADY_EXISTS');
    const zero = await wallet('0');
    await invariant(zero.id, '0.00');
  });
  test('concurrent bets cannot overspend, rejected operation has no ledger', async () => {
    const w = await wallet();
    const results = await Promise.all(
      [1, 2].map(() =>
        service.execute(wager(w, { money: { amount: '80', currency: 'BRL' } }), ctx),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    await invariant(w.id, '20.00');
    const [count] = await db.query(
      "SELECT count(*)::int n FROM wallet_ledger WHERE wallet_id=$1 AND direction='DEBIT'",
      [w.id],
    );
    expect(count.n).toBe(1);
  });
  test('50 duplicate requests across three real processes cause one debit', async () => {
    const w = await wallet();
    const command = wager(w);
    const results = await Promise.all(
      [17, 17, 16].map(async (count) => {
        const child = Bun.spawn([process.execPath, 'test/fixtures/process-wager.ts'], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, COMMANDS: JSON.stringify(Array(count).fill(command)) },
        });
        const output = await new Response(child.stdout).text();
        const error = await new Response(child.stderr).text();
        if ((await child.exited) !== 0) {
          throw new Error(error);
        }

        return JSON.parse(output) as {
          idempotentReplay: boolean;
        }[];
      }),
    );
    expect(results.flat().filter((r) => !r.idempotentReplay)).toHaveLength(1);
    await invariant(w.id, '90.00');
  }, 30000);
  test('replay preserves historical balance; divergent key or external identity conflicts', async () => {
    const w = await wallet();
    const command = wager(w);
    const first = await service.execute(command, ctx);
    await service.execute(wager(w), ctx);
    const replay = await service.execute(command, ctx);
    expect(replay.balance).toEqual(first.balance);
    expect(replay.idempotentReplay).toBe(true);
    await expect(
      service.execute({ ...command, money: { amount: '11', currency: 'BRL' } }, ctx),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(
      service.execute({ ...command, idempotencyKey: 'different:' + randomUUID() }, ctx),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await invariant(w.id, '80.00');
  });
  test('inbox, money, ledger and outbox roll back together and redelivery is safe', async () => {
    const w = await wallet();
    const command = wager(w);
    const context = {
      ...ctx,
      inbox: { consumerName: 'test', messageId: randomUUID(), payloadHash: 'a'.repeat(64) },
    };
    // Database trigger injects failure at event persistence, after balance and ledger writes.
    await db.query(`CREATE OR REPLACE FUNCTION fail_test_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.aggregate_id='${w.id}'::uuid THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_outbox_failure BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION fail_test_outbox()`);
    try {
      await expect(service.execute(command, context)).rejects.toThrow('injected outbox failure');
    } finally {
      await db.query(
        'DROP TRIGGER test_outbox_failure ON outbox_messages; DROP FUNCTION fail_test_outbox()',
      );
    }

    const [inbox] = await db.query(
      'SELECT count(*)::int n FROM inbox_messages WHERE message_id=$1',
      [context.inbox.messageId],
    );
    expect(inbox.n).toBe(0);
    await invariant(w.id, '100.00');
    const [transactions] = await db.query(
      'SELECT count(*)::int n FROM wager_transactions WHERE idempotency_key=$1',
      [command.idempotencyKey],
    );
    expect(transactions.n).toBe(0);
    const first = await service.execute(command, context);
    expect((await service.execute(command, context)).transactionId).toBe(first.transactionId);
    await expect(
      service.execute(command, {
        ...context,
        inbox: { ...context.inbox, payloadHash: 'b'.repeat(64) },
      }),
    ).rejects.toThrow('INBOX_PAYLOAD_CONFLICT');
    await invariant(w.id, '90.00');
  });
  test('WIN, LOSS, REFUND, ROLLBACK and duplicate reversal rules', async () => {
    const w = await wallet();
    const bet = wager(w);
    await service.execute(bet, ctx);
    const win = wager(w, {
      kind: 'WIN',
      money: { amount: '30', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await service.execute(win, ctx);
    const loss = await service.execute(
      wager(w, { kind: 'LOSS', money: { amount: '0', currency: 'BRL' } }),
      ctx,
    );
    const [count] = await db.query(
      'SELECT count(*)::int n FROM wallet_ledger WHERE transaction_id=$1',
      [loss.transactionId],
    );
    expect(count.n).toBe(0);
    const refund = wager(w, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await service.execute(refund, ctx)).status).toBe('PROCESSED');
    expect(
      (
        await service.execute(
          wager(w, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }),
          ctx,
        )
      ).failureCode,
    ).toBe('REFERENCE_ALREADY_REVERSED');
    await service.execute(
      wager(w, { kind: 'ROLLBACK', referenceExternalTransactionId: refund.externalTransactionId }),
      ctx,
    );
    await invariant(w.id, '120.00');
  });
  test('reversal debit has a distinct insufficient-funds rejection', async () => {
    const w = await wallet('0');
    const win = wager(w, { kind: 'WIN', money: { amount: '10', currency: 'BRL' } });
    await service.execute(win, ctx);
    await service.execute(wager(w), ctx);
    const result = await service.execute(
      wager(w, { kind: 'ROLLBACK', referenceExternalTransactionId: win.externalTransactionId }),
      ctx,
    );
    expect(result.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    await invariant(w.id, '0.00');
  });
  test('out-of-order refund resumes after reference and expires when missing', async () => {
    const w = await wallet();
    const bet = wager(w);
    const refund = wager(w, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const pending = await service.execute(refund, ctx);
    expect(pending.status).toBe('PENDING_REFERENCE');
    await service.execute(bet, ctx);
    await db.query(
      "UPDATE wager_transactions SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [pending.transactionId],
    );
    await new FinancialRepository(db).resume(pending.transactionId);
    expect((await service.execute(refund, ctx)).status).toBe('PROCESSED');
    await invariant(w.id, '100.00');
    const missing = await service.execute(
      wager(w, { kind: 'ROLLBACK', referenceExternalTransactionId: randomUUID() }),
      ctx,
    );
    await db.query(
      "UPDATE wager_transactions SET attempts=20,next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [missing.transactionId],
    );
    await repository.resume(missing.transactionId);
    const result = (await repository.findTransaction(missing.transactionId)) as {
      failureCode: string;
    };
    expect(result.failureCode).toBe('REFERENCE_EXPIRED');
    await invariant(w.id);
  });
  test('database prevents ledger mutation, unmatched balance writes and terminal changes', async () => {
    const w = await wallet();
    await expect(db.query('UPDATE wallets SET balance=99 WHERE id=$1', [w.id])).rejects.toThrow(
      'wallet/ledger',
    );
    await expect(
      db.query('UPDATE wallet_ledger SET amount=1 WHERE wallet_id=$1', [w.id]),
    ).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM wallet_ledger WHERE wallet_id=$1', [w.id])).rejects.toThrow(
      'append-only',
    );
    await expect(
      db.query("UPDATE wager_transactions SET status='PENDING' WHERE wallet_id=$1", [w.id]),
    ).rejects.toThrow();
    await invariant(w.id, '100.00');
  });
  test('ledger cursor is stable and scoped to its wallet', async () => {
    const w = await wallet();
    await service.execute(wager(w), ctx);
    const page = (await repository.ledger(w.id, undefined, 1)) as {
      entries: unknown[];
      nextCursor: string;
    };
    expect(page.entries).toHaveLength(1);
    const next = (await repository.ledger(w.id, page.nextCursor, 1)) as {
      entries: unknown[];
    };
    expect(next.entries).toHaveLength(1);
    await expect(repository.ledger((await wallet()).id, page.nextCursor, 1)).rejects.toThrow(
      'INVALID_CURSOR',
    );
    await invariant(w.id);
  });
  test('unrelated wallets keep processing while another wallet is locked', async () => {
    const first = await wallet();
    const second = await wallet();
    const lock = db.createQueryRunner();
    await lock.connect();
    await lock.startTransaction();
    try {
      await lock.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [first.id]);
      const result = await Promise.race([
        service.execute(wager(second), ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Other wallet blocked')), 1500),
        ),
      ]);
      expect(result.status).toBe('PROCESSED');
    } finally {
      await lock.rollbackTransaction();
      await lock.release();
    }

    await invariant(first.id, '100.00');
    await invariant(second.id, '90.00');
  });
  test('reference mismatch, currency mismatch and invalid reversal amounts are auditable rejections', async () => {
    const w = await wallet();
    const bet = wager(w);
    await service.execute(bet, ctx);
    expect(
      (await service.execute(wager(w, { money: { amount: '1', currency: 'USD' } }), ctx))
        .failureCode,
    ).toBe('CURRENCY_MISMATCH');
    expect((await service.execute(wager(w, { playerId: randomUUID() }), ctx)).failureCode).toBe(
      'PLAYER_MISMATCH',
    );
    expect(
      (
        await service.execute(
          wager(w, {
            kind: 'REFUND',
            referenceExternalTransactionId: bet.externalTransactionId,
            money: { amount: '1', currency: 'BRL' },
          }),
          ctx,
        )
      ).failureCode,
    ).toBe('REFERENCE_AMOUNT_MISMATCH');
    const other = await wallet();
    expect(
      (
        await service.execute(
          wager(other, {
            kind: 'REFUND',
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
          ctx,
        )
      ).failureCode,
    ).toBe('REFERENCE_CONTEXT_MISMATCH');
    await invariant(w.id, '90.00');
    await invariant(other.id, '100.00');
  });
  test('HTTP wiring validates contracts, replays and exposes queries', async () => {
    process.env.DATABASE_URL = url;
    process.env.RUN_WORKERS = 'false';
    const { createApplication } = await import('../../src/bootstrap.js');
    const app = await createApplication(true);
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const request = (path: string, body: unknown, key?: string) =>
        fetch(base + path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key ? { 'idempotency-key': key } : {}),
          },
          body: JSON.stringify(body),
        });
      const response = await request('/wallets', {
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(response.status).toBe(201);
      const w = (await response.json()) as {
        id: string;
        playerId: string;
      };
      const command = wager(w);
      const { idempotencyKey, ...body } = command;
      expect((await request('/wagering/transactions', body)).status).toBe(400);
      expect(
        (await request('/wagering/transactions', { ...body, kind: 'OPENING' }, idempotencyKey))
          .status,
      ).toBe(400);
      const result = await request('/wagering/transactions', body, idempotencyKey);
      expect(result.status).toBe(200);
      const processed = (await result.json()) as {
        transactionId: string;
      };
      const replay = await request('/wagering/transactions', body, idempotencyKey);
      expect(
        (
          (await replay.json()) as {
            idempotentReplay: boolean;
          }
        ).idempotentReplay,
      ).toBe(true);
      expect(
        (
          await request(
            '/wagering/transactions',
            { ...body, money: { amount: '11', currency: 'BRL' } },
            idempotencyKey,
          )
        ).status,
      ).toBe(409);
      expect((await fetch(base + '/wagering/transactions/' + processed.transactionId)).status).toBe(
        200,
      );
      expect((await fetch(base + `/wallets/${w.id}/ledger?limit=1`)).status).toBe(200);
      expect((await fetch(base + '/health/live')).status).toBe(200);
      const reconciled = await request(`/wallets/${w.id}/reconciliation`, {});
      expect(
        (
          (await reconciled.json()) as {
            consistent: boolean;
          }
        ).consistent,
      ).toBe(true);
      await invariant(w.id, '90.00');
    } finally {
      await app.close();
    }
  }, 15000);
  test('concurrent outbox claims do not overlap and expired leases recover', async () => {
    const publishers = [new OutboxRepository(db), new OutboxRepository(db)];
    const claimed = await Promise.all(publishers.map((p) => p.claim()));
    expect(claimed[0]?.id).not.toBe(claimed[1]?.id);
    const first = claimed[0]!;
    await db.query("UPDATE outbox_messages SET lease_until=now()-interval '1 second' WHERE id=$1", [
      first.id,
    ]);
    const recovered = await publishers[1]!.claim();
    expect(recovered?.id).toBe(first.id);
    await publishers[0]!.published(first); // Old lease owner cannot confirm a newer claim.
    const [row] = await db.query('SELECT published_at FROM outbox_messages WHERE id=$1', [
      first.id,
    ]);
    expect(row.published_at).toBeNull();
    await publishers[1]!.published(recovered!);
    await publishers[1]!.published(claimed[1]!);
  });
  test('exhausted infrastructure attempts produce an immutable audit record without moving money', async () => {
    const w = await wallet();
    const command = wager(w);
    const { payloadHash } = await import('../../src/module/domains/canonical-payload.js');
    const { idempotencyKey: _, ...business } = command;
    const failed = await repository.recordFailure(command, payloadHash(business), ctx);
    expect(failed.status).toBe('FAILED');
    expect(failed.failureCode).toBe('INFRASTRUCTURE_RETRY_EXHAUSTED');
    expect((await service.execute(command, ctx)).status).toBe('FAILED');
    await invariant(w.id, '100.00');
  });
  test('financial migration down/up is reversible inside an isolated rollback', async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const migration = new FinancialProcessing1790000001000();
      await migration.down(runner);
      await migration.up(runner);
      const [row] = await runner.query("SELECT to_regclass('wallet_ledger')::text name");
      expect(row.name).toBe('wallet_ledger');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
