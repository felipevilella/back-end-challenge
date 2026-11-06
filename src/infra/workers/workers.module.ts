import { Module } from '@nestjs/common';
import { RepositoriesModule } from '../repositories/repositories.module';
import { OutboxRepository } from '../repositories/outbox.repository';
import { UseCaseProxyModule } from '../usecase-proxy/usecase-proxy.module';
import { SqsModule } from '../messaging/sqs.module';
import { WorkersService } from './workers.service';

@Module({
  imports: [RepositoriesModule, UseCaseProxyModule.register(), SqsModule],
  providers: [OutboxRepository, WorkersService],
})
export class WorkersModule {}
