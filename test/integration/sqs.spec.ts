import 'reflect-metadata';
import { persistenceEntities } from '../../src/infra/entities';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { InitialWallets1790000000000 } from '../../src/infra/database/typeorm/migrations/1790000000000-initial-wallets';
import { FinancialProcessing1790000001000 } from '../../src/infra/database/typeorm/migrations/1790000001000-financial-processing';
import { FinancialRepository } from '../../src/infra/repositories/financial.repository';
import { OutboxRepository } from '../../src/infra/repositories/outbox.repository';
import { ProcessWagerService } from '../../src/module/wagering/services/process-wager.service';
import { UseCaseProxy } from '../../src/infra/usecase-proxy/usecase-proxy';
import { WorkersService } from '../../src/infra/workers/workers.service';
import { Telemetry } from '../../src/infra/observability/telemetry';

const enabled = process.env.TEST_DATABASE_URL && process.env.TEST_SQS_ENDPOINT;

(enabled ? describe : describe.skip)('SQS integration (real PostgreSQL + LocalStack)', () => {
  const database = new DataSource({
    type: 'postgres',
    url: process.env.TEST_DATABASE_URL,
    entities: persistenceEntities,
    migrations: [InitialWallets1790000000000, FinancialProcessing1790000001000],
  });
  const sqs = new SQSClient({
    endpoint: process.env.TEST_SQS_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const savedEnv = {
    queue: process.env.SQS_QUEUE_URL,
    dlq: process.env.SQS_DLQ_URL,
    events: process.env.SQS_EVENTS_QUEUE_URL,
  };
  const queues: string[] = [];
  let financial: FinancialRepository;
  let workers: WorkersService[];
  let service: ProcessWagerService;
  async function createQueue(label: string) {
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: `test-${label}-${randomUUID()}.fifo`,
        Attributes: { FifoQueue: 'true' },
      }),
    );
    queues.push(result.QueueUrl!);

    return result.QueueUrl!;
  }
  beforeAll(async () => {
    await database.initialize();
    await database.runMigrations();
    process.env.SQS_QUEUE_URL = await createQueue('wagers');
    process.env.SQS_DLQ_URL = await createQueue('dlq');
    process.env.SQS_EVENTS_QUEUE_URL = await createQueue('events');
    financial = new FinancialRepository(database);
    service = new ProcessWagerService(financial);
    workers = [0, 1].map(
      () =>
        new WorkersService(
          sqs,
          financial,
          new OutboxRepository(database),
          new UseCaseProxy(service),
          new Telemetry(),
        ),
    );
  }, 30000);
  afterAll(async () => {
    for (const QueueUrl of queues) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl }));
    }
    process.env.SQS_QUEUE_URL = savedEnv.queue;
    process.env.SQS_DLQ_URL = savedEnv.dlq;
    process.env.SQS_EVENTS_QUEUE_URL = savedEnv.events;
    sqs.destroy();
    if (database.isInitialized) {
      await database.destroy();
    }
  });
  async function requested() {
    const w = (await financial.createWallet(
      randomUUID(),
      { amount: '100', currency: 'BRL' },
      { correlationId: 'sqs-test' },
    )) as {
      id: string;
      playerId: string;
    };
    const external = randomUUID();

    return {
      w,
      envelope: {
        messageId: randomUUID(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'sqs-test',
          externalTransactionId: external,
          idempotencyKey: `sqs-test:${external}`,
          playerId: w.playerId,
          walletId: w.id,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET' as const,
          money: { amount: '10', currency: 'BRL' },
        },
      },
    };
  }
  async function send(envelope: Awaited<ReturnType<typeof requested>>['envelope']) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: envelope.data.walletId,
        MessageDeduplicationId: randomUUID(),
      }),
    );
  }
  test('redelivery with different transport IDs is deduplicated by inbox and transaction key', async () => {
    const { w, envelope } = await requested();
    await send(envelope);
    await workers[0]!.consumeOnce();
    await send(envelope);
    await workers[1]!.consumeOnce();
    const result = (await financial.reconcile(w.id)) as {
      consistent: boolean;
      storedBalance: {
        amount: string;
      };
    };
    expect(result.consistent).toBe(true);
    expect(result.storedBalance.amount).toBe('90.00');
    const [row] = await database.query(
      'SELECT count(*)::int n FROM inbox_messages WHERE message_id=$1',
      [envelope.messageId],
    );
    expect(row.n).toBe(1);
  }, 15000);
  test('process dies after commit and before ack; another worker safely completes redelivery', async () => {
    const { w, envelope } = await requested();
    await send(envelope);
    const child = Bun.spawn([process.execPath, 'test/fixtures/worker-once.ts'], {
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'test', TEST_CRASH_AFTER_COMMIT: 'true' },
    });
    const error = await new Response(child.stderr).text();
    const exit = await child.exited;
    if (exit !== 91) {
      throw new Error(`Unexpected worker exit ${exit}: ${error}`);
    }

    await workers[1]!.consumeOnce();
    const result = (await financial.reconcile(w.id)) as {
      consistent: boolean;
      storedBalance: {
        amount: string;
      };
    };
    expect(result.consistent).toBe(true);
    expect(result.storedBalance.amount).toBe('90.00');
  }, 20000);
  test('permanent malformed messages reach DLQ before ack', async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageBody: 'malformed',
        MessageGroupId: 'invalid',
        MessageDeduplicationId: randomUUID(),
      }),
    );
    await workers[0]!.consumeOnce();
    const dlq = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: process.env.SQS_DLQ_URL, WaitTimeSeconds: 2 }),
    );
    expect(dlq.Messages?.[0]?.Body).toBe('malformed');
    if (dlq.Messages?.[0]) {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: process.env.SQS_DLQ_URL,
          ReceiptHandle: dlq.Messages[0].ReceiptHandle,
        }),
      );
    }
  }, 10000);
  test('concurrent publishers publish committed events and recover after crash before confirmation', async () => {
    // Recover any abandoned claims from preceding test runs, without changing published events.
    await database.query(
      "UPDATE outbox_messages SET lease_until=now()-interval '1 second' WHERE published_at IS NULL AND lease_token IS NOT NULL",
    );
    const child = Bun.spawn([process.execPath, 'test/fixtures/worker-once.ts'], {
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WORKER_TEST_MODE: 'publisher',
        TEST_CRASH_AFTER_PUBLISH: 'true',
      },
    });
    const error = await new Response(child.stderr).text();
    const exit = await child.exited;
    if (exit !== 92) {
      throw new Error(`Unexpected publisher exit ${exit}: ${error}`);
    }

    await database.query(
      "UPDATE outbox_messages SET lease_until=now()-interval '1 second' WHERE published_at IS NULL AND lease_token IS NOT NULL",
    );
    for (let i = 0; i < 200; i++) {
      const results = await Promise.all(workers.map((worker) => worker.publishOnce()));
      if (results.every((value) => !value)) {
        break;
      }
    }
    const [row] = await database.query(
      'SELECT count(*)::int n FROM outbox_messages WHERE published_at IS NULL',
    );
    expect(row.n).toBe(0);
    const attributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: process.env.SQS_EVENTS_QUEUE_URL,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    expect(Number(attributes.Attributes?.ApproximateNumberOfMessages)).toBeGreaterThan(0);
  }, 30000);
});
