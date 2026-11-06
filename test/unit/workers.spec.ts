import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { WorkersService } from '../../src/infra/workers/workers.service';
import { FinancialRepository } from '../../src/infra/repositories/financial.repository';
import { OutboxRepository } from '../../src/infra/repositories/outbox.repository';
import { ProcessWagerService } from '../../src/module/wagering/services/process-wager.service';
import { UseCaseProxy } from '../../src/infra/usecase-proxy/usecase-proxy';
import { Telemetry } from '../../src/infra/observability/telemetry';
import type {
  IFinancialRepository,
  WagerResult,
} from '../../src/repositories/financial.repository.interface';

const result: WagerResult = {
  transactionId: randomUUID(),
  status: 'PROCESSED',
  balance: { amount: '90.00', currency: 'BRL' },
  idempotentReplay: false,
};

function message(attempt = '1') {
  return {
    MessageId: randomUUID(),
    ReceiptHandle: 'receipt',
    Attributes: { ApproximateReceiveCount: attempt },
    Body: JSON.stringify({
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'p',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    }),
  };
}

function worker(
  process: () => Promise<WagerResult>,
  calls: unknown[],
  options: {
    outbox?: unknown;
    recordFailure?: () => Promise<WagerResult>;
    send?: (command: unknown) => Promise<unknown>;
  } = {},
) {
  const client = {
    send: async (command: unknown) => {
      calls.push(command);

      return options.send ? options.send(command) : {};
    },
  } as unknown as SQSClient;
  const financial = {
    process,
    recordFailure: options.recordFailure,
  } as unknown as FinancialRepository;

  return new WorkersService(
    client,
    financial,
    (options.outbox ?? {}) as OutboxRepository,
    new UseCaseProxy(new ProcessWagerService(financial as IFinancialRepository)),
    new Telemetry(),
  );
}

test('consumer acks only after financial commit resolves', async () => {
  let commit!: (value: WagerResult) => void;
  const pending = new Promise<WagerResult>((resolve) => {
    commit = resolve;
  });
  const calls: unknown[] = [];
  const consumer = worker(() => pending, calls);
  const handling = consumer.handle(message());
  await Bun.sleep(1);
  expect(calls).toHaveLength(0);
  commit(result);
  await handling;
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBeInstanceOf(DeleteMessageCommand);
});

test('transient failures release visibility with backoff without ack', async () => {
  const calls: unknown[] = [];
  const consumer = worker(async () => {
    throw new Error('database unavailable');
  }, calls);
  await consumer.handle(message());
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
  expect((calls[0] as ChangeMessageVisibilityCommand).input.VisibilityTimeout).toBe(2);
});

test('malformed messages are sent to DLQ before deleting the original', async () => {
  const calls: unknown[] = [];
  const consumer = worker(async () => result, calls);
  await consumer.handle({ ...message(), Body: 'not json' });
  expect(calls[0]).toBeInstanceOf(SendMessageCommand);
  expect(calls[1]).toBeInstanceOf(DeleteMessageCommand);
});

test('exhausted retries persist a failed result before DLQ and ack', async () => {
  const calls: unknown[] = [];
  const consumer = worker(
    async () => {
      throw new Error('infrastructure');
    },
    calls,
    {
      recordFailure: async () => {
        calls.push('failed audit committed');

        return { ...result, status: 'FAILED', failureCode: 'INFRASTRUCTURE_RETRY_EXHAUSTED' };
      },
    },
  );
  await consumer.handle(message('5'));
  expect(calls[0]).toBe('failed audit committed');
  expect(calls[1]).toBeInstanceOf(SendMessageCommand);
  expect(calls[2]).toBeInstanceOf(DeleteMessageCommand);
});

test('failed DLQ sends leave the original message unacked', async () => {
  const calls: unknown[] = [];
  const consumer = worker(async () => result, calls, {
    send: async () => {
      throw new Error('SQS down');
    },
  });
  await expect(consumer.handle({ ...message(), Body: 'invalid' })).rejects.toThrow('SQS down');
  expect(calls.filter((command) => command instanceof DeleteMessageCommand)).toHaveLength(0);
});

test('publisher retries failed sends and confirms successful sends with stable event ID', async () => {
  const event = {
    id: randomUUID(),
    aggregateId: randomUUID(),
    payload: { eventId: randomUUID() },
    leaseToken: randomUUID(),
    attempts: 0,
  };
  const calls: unknown[] = [];
  const outbox = {
    lag: async () => 1,
    claim: async () => event,
    retry: async () => {
      calls.push('retry');
    },
    published: async () => {
      calls.push('published');
    },
  };
  const failure = worker(async () => result, calls, {
    outbox,
    send: async () => {
      throw new Error('SQS down');
    },
  });
  await failure.publishOnce();
  expect(calls.at(-1)).toBe('retry');
  const success = worker(async () => result, calls, { outbox });
  await success.publishOnce();
  expect(calls.at(-1)).toBe('published');
  const sends = calls.filter(
    (command) => command instanceof SendMessageCommand,
  ) as SendMessageCommand[];
  expect(sends[0]?.input.MessageDeduplicationId).toBe(event.id);
  expect(sends[1]?.input.MessageDeduplicationId).toBe(event.id);
});
