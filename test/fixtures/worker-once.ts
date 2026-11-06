import 'reflect-metadata';
import { persistenceEntities } from '../../src/infra/entities';
import { DataSource } from 'typeorm';
import { ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { FinancialRepository } from '../../src/infra/repositories/financial.repository';
import { OutboxRepository } from '../../src/infra/repositories/outbox.repository';
import { ProcessWagerService } from '../../src/module/wagering/services/process-wager.service';
import { UseCaseProxy } from '../../src/infra/usecase-proxy/usecase-proxy';
import { WorkersService } from '../../src/infra/workers/workers.service';
import { Telemetry } from '../../src/infra/observability/telemetry';

async function main() {
  const database = new DataSource({
    type: 'postgres',
    url: process.env.TEST_DATABASE_URL,
    entities: persistenceEntities,
  });
  const sqs = new SQSClient({
    endpoint: process.env.TEST_SQS_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  await database.initialize();
  try {
    const repository = new FinancialRepository(database);
    const worker = new WorkersService(
      sqs,
      repository,
      new OutboxRepository(database),
      new UseCaseProxy(new ProcessWagerService(repository)),
      new Telemetry(),
    );
    if (process.env.WORKER_TEST_MODE === 'publisher') {
      await worker.publishOnce();
    } else {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: process.env.SQS_QUEUE_URL,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          VisibilityTimeout: 1,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      if (!response.Messages?.[0]) {
        throw new Error('No message to process');
      }

      await worker.handle(response.Messages[0]);
    }
  } finally {
    sqs.destroy();
    await database.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
