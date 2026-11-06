import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('outbox_messages')
export class OutboxMessageEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'aggregate_id' })
  aggregateId!: string;

  @Column('text', { name: 'event_type' })
  eventType!: string;

  @Column('jsonb')
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;

  @Column('integer', { default: 0 })
  attempts!: number;

  @Column('timestamptz', { name: 'next_attempt_at', default: () => 'CURRENT_TIMESTAMP' })
  nextAttemptAt!: Date;

  @Column('timestamptz', { name: 'published_at', nullable: true })
  publishedAt!: Date | null;

  @Column('uuid', { name: 'lease_token', nullable: true })
  leaseToken!: string | null;

  @Column('timestamptz', { name: 'lease_until', nullable: true })
  leaseUntil!: Date | null;
}
