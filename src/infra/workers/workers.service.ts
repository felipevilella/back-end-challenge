import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createHash } from 'node:crypto';
import { FinancialRepository } from '../repositories/financial.repository';
import { OutboxRepository } from '../repositories/outbox.repository';
import { ProcessWagerService } from '../../module/wagering/services/process-wager.service';
import { payloadHash } from '../../module/domains/canonical-payload';
import { WagerMessageDto } from '../../module/wagering/dto/wager.dto';
import { UseCaseProxy } from '../usecase-proxy/usecase-proxy';
import { UseCaseProxyModule } from '../usecase-proxy/usecase-proxy.module';
import { Money } from '../../module/domains/money';
import { DomainError } from '../../module/domains/domain-error';
import { Telemetry } from '../observability/telemetry';

@Injectable()
export class WorkersService
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly stop = new AbortController();

  private tasks: Promise<void>[] = [];

  constructor(
    private readonly sqs: SQSClient,
    private readonly financial: FinancialRepository,
    private readonly outbox: OutboxRepository,
    @Inject(UseCaseProxyModule.PROCESS_WAGER_SERVICE)
    private readonly process: UseCaseProxy<ProcessWagerService>,
    private readonly telemetry: Telemetry,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.RUN_WORKERS !== 'true') {
      return;
    }

    for (const name of ['SQS_QUEUE_URL', 'SQS_DLQ_URL', 'SQS_EVENTS_QUEUE_URL']) {
      if (!process.env[name]) {
        throw new Error(`${name} is required for workers`);
      }
    }
    this.tasks = [
      this.loop('consumer', () => this.consumeOnce()),
      this.loop('outbox', () => this.publishOnce()),
      this.loop('references', () => this.referencesOnce()),
    ];
  }

  private async pause(ms: number): Promise<void> {
    if (this.stop.signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.stop.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.stop.signal.addEventListener('abort', done, { once: true });
    });
  }

  private async loop(worker: string, run: () => Promise<boolean>): Promise<void> {
    while (!this.stop.signal.aborted) {
      try {
        if (!(await run())) {
          await this.pause(worker === 'references' ? 1000 : 250);
        }
      } catch {
        if (!this.stop.signal.aborted) {
          this.telemetry.increment('worker_errors_total', `worker="${worker}"`);
          this.telemetry.log('worker_retry', { worker });
          await this.pause(1000);
        }
      }
    }
  }

  async publishOnce(): Promise<boolean> {
    this.telemetry.setOutboxLag(await this.outbox.lag());
    const message = await this.outbox.claim();
    if (!message) {
      return false;
    }

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: process.env.SQS_EVENTS_QUEUE_URL,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      // A crash here can duplicate a delivery; eventId is stable and consumers must deduplicate it.
      if (process.env.TEST_CRASH_AFTER_PUBLISH === 'true' && process.env.NODE_ENV === 'test') {
        process.exit(92);
      }

      await this.outbox.published(message);
      this.telemetry.increment('outbox_published_total');
    } catch {
      this.telemetry.increment('retries_total', 'worker="outbox"');
      await this.outbox.retry(message);
    }

    return true;
  }

  async referencesOnce(): Promise<boolean> {
    const candidates = await this.financial.findPendingReferences();
    for (const row of candidates) {
      if (this.stop.signal.aborted) {
        break;
      }

      const result = await this.financial.resume(row.id);
      if (result) {
        this.telemetry.increment('transactions_total', `status="${result.status}"`);
        this.telemetry.log('reference_result', {
          transactionId: row.id,
          walletId: row.walletId,
          providerId: row.providerId,
          correlationId: row.correlationId,
          status: result.status,
        });
      }

      this.telemetry.increment('retries_total', 'worker="reference"');
    }

    return candidates.length > 0;
  }

  async consumeOnce(): Promise<boolean> {
    const received = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 60,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal: this.stop.signal },
    );
    const message = received.Messages?.[0];
    if (!message) {
      return false;
    }

    if (this.stop.signal.aborted) {
      await this.visibility(message, 0);

      return false;
    }

    await this.handle(message);

    return true;
  }

  private async visibility(message: Message, timeout: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: timeout,
      }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle,
      }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
  }

  async handle(message: Message): Promise<void> {
    // Heartbeat runs until commit/ack or visibility release, including during graceful shutdown.
    const heartbeat = setInterval(() => {
      void this.visibility(message, 60).catch(() =>
        this.telemetry.increment('visibility_errors_total'),
      );
    }, 20000);
    let envelope: WagerMessageDto | undefined;
    let committed = false;
    try {
      try {
        envelope = plainToInstance(WagerMessageDto, JSON.parse(message.Body ?? ''));
        const errors = await validate(envelope, {
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
        });
        if (errors.length) {
          throw new Error();
        }
      } catch {
        throw new DomainError('INVALID_QUEUE_MESSAGE', 400);
      }

      await this.process.getInstance().execute(envelope.data, {
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        inbox: {
          consumerName: 'wager-transactions-v1',
          messageId: envelope.messageId,
          payloadHash: payloadHash(envelope),
        },
      });
      committed = true;
      // Test crash injection is opt-in and never enabled by default.
      if (process.env.TEST_CRASH_AFTER_COMMIT === 'true' && process.env.NODE_ENV === 'test') {
        process.exit(91);
      }

      await this.ack(message);
    } catch (error) {
      if (committed) {
        this.telemetry.increment('retries_total', 'worker="ack"');
        await this.visibility(message, 2);

        return;
      }

      const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      const permanent = error instanceof DomainError;
      this.telemetry.log(permanent ? 'queue_permanent_failure' : 'queue_retry', {
        correlationId: envelope?.messageId,
        messageId: envelope?.messageId ?? message.MessageId,
        walletId: envelope?.data?.walletId,
        providerId: envelope?.data?.providerId,
        failureCode: permanent ? error.code : 'INFRASTRUCTURE_FAILURE',
        attempts,
      });
      if (permanent || attempts >= 5) {
        if (!permanent && envelope) {
          const normalized = { ...envelope.data, money: Money.from(envelope.data.money).toJSON() };
          const { idempotencyKey: _, ...business } = normalized;
          const audited = await this.financial.recordFailure(normalized, payloadHash(business), {
            correlationId: envelope.messageId,
            causationId: envelope.messageId,
            inbox: {
              consumerName: 'wager-transactions-v1',
              messageId: envelope.messageId,
              payloadHash: payloadHash(envelope),
            },
          });
          if (audited.status !== 'FAILED') {
            await this.ack(message);

            return;
          }

          this.telemetry.increment('transactions_total', 'status="FAILED"');
        }
        // Send to DLQ before deleting the original. A crash may duplicate the DLQ item, never lose it.
        const id =
          message.MessageId ??
          createHash('sha256')
            .update(message.Body ?? '')
            .digest('hex');
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: process.env.SQS_DLQ_URL,
            MessageBody: message.Body || '{}',
            MessageGroupId: 'failed-wagers',
            MessageDeduplicationId: id,
            MessageAttributes: {
              FailureCode: {
                DataType: 'String',
                StringValue: permanent ? error.code : 'RETRY_EXHAUSTED',
              },
            },
          }),
          { abortSignal: AbortSignal.timeout(10000) },
        );
        this.telemetry.increment('dlq_messages_total');
        await this.ack(message);
      } else {
        this.telemetry.increment('retries_total', 'worker="consumer"');
        await this.visibility(message, Math.min(300, 2 ** attempts));
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled(this.tasks);
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
