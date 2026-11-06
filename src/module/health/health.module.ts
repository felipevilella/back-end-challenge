import { Module } from '@nestjs/common';
import { SqsModule } from '../../infra/messaging/sqs.module';
import { HealthController } from './health.controller';

@Module({ imports: [SqsModule], controllers: [HealthController] })
export class HealthModule {}
