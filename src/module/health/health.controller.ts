import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { Telemetry } from '../../infra/observability/telemetry';
import { DataSource } from 'typeorm';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DataSource,
    private readonly sqs: SQSClient,
    private readonly telemetry: Telemetry,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics() {
    return this.telemetry.render();
  }

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      if (!process.env.SQS_QUEUE_URL) {
        throw new Error('Missing SQS_QUEUE_URL');
      }

      await Promise.all([
        this.database.query('SELECT 1'),
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: process.env.SQS_QUEUE_URL,
            AttributeNames: ['QueueArn'],
          }),
          { abortSignal: AbortSignal.timeout(3000) },
        ),
      ]);

      return { status: 'ok', postgres: 'up', sqs: 'up' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }
}
