import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';

export interface ClaimedOutboxMessage {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  leaseToken: string;
}

@Injectable()
export class OutboxRepository {
  constructor(private readonly database: DataSource) {}

  async claim(): Promise<ClaimedOutboxMessage | undefined> {
    return this.database.transaction(async (manager) => {
      const messages = manager.getRepository(OutboxMessageEntity);
      const message = await messages
        .createQueryBuilder('message')
        .where({ publishedAt: IsNull() })
        .andWhere('message.nextAttemptAt <= CURRENT_TIMESTAMP')
        .andWhere('(message.leaseUntil IS NULL OR message.leaseUntil < CURRENT_TIMESTAMP)')
        .orderBy('message.occurredAt', 'ASC')
        .addOrderBy('message.id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(1)
        .getOne();
      if (!message) {
        return undefined;
      }

      const leaseToken = randomUUID();
      await messages.update(message.id, {
        leaseToken,
        leaseUntil: () => "CURRENT_TIMESTAMP + INTERVAL '60 seconds'",
      });

      return {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload,
        attempts: message.attempts,
        leaseToken,
      };
    });
  }

  async published(message: ClaimedOutboxMessage): Promise<void> {
    await this.database.getRepository(OutboxMessageEntity).update(
      {
        id: message.id,
        leaseToken: message.leaseToken,
        publishedAt: IsNull(),
      },
      {
        publishedAt: () => 'CURRENT_TIMESTAMP',
        leaseToken: null,
        leaseUntil: null,
      },
    );
  }

  async retry(message: ClaimedOutboxMessage): Promise<void> {
    const delay = Math.min(300, 2 ** Math.min(message.attempts, 8));
    await this.database
      .getRepository(OutboxMessageEntity)
      .createQueryBuilder()
      .update()
      .set({
        attempts: () => 'attempts + 1',
        nextAttemptAt: () => "CURRENT_TIMESTAMP + (:delay * INTERVAL '1 second')",
        leaseToken: null,
        leaseUntil: null,
      })
      .where({
        id: message.id,
        leaseToken: message.leaseToken,
        publishedAt: IsNull(),
      })
      .setParameter('delay', delay)
      .execute();
  }

  async lag(): Promise<number> {
    const row = await this.database
      .getRepository(OutboxMessageEntity)
      .createQueryBuilder('message')
      .select(
        'COALESCE(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - MIN(message.occurredAt)), 0)::text',
        'lag',
      )
      .where({ publishedAt: IsNull() })
      .getRawOne<{
        lag: string;
      }>();

    return Number(row?.lag ?? '0');
  }
}
