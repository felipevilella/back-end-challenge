import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { TransactionKind, TransactionStatus } from '../../module/domains/wager-transaction';
import type { WagerResult } from '../../repositories/financial.repository.interface';

@Entity('wager_transactions')
export class WagerTransactionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('varchar', { name: 'provider_id', length: 128 })
  providerId!: string;

  @Column('varchar', { name: 'external_transaction_id', length: 256 })
  externalTransactionId!: string;

  @Column('varchar', { name: 'idempotency_key', length: 256 })
  idempotencyKey!: string;

  @Column('char', { name: 'payload_hash', length: 64 })
  payloadHash!: string;

  @Column('uuid', { name: 'wallet_id' })
  walletId!: string;

  @Column('uuid', { name: 'player_id' })
  playerId!: string;

  @Column('varchar', { name: 'round_id', length: 256 })
  roundId!: string;

  @Column('varchar', { name: 'game_id', length: 256 })
  gameId!: string;

  @Column('text')
  kind!: TransactionKind;

  @Column('numeric', { precision: 20, scale: 2 })
  amount!: string;

  @Column('varchar', { length: 3 })
  currency!: string;

  @Column('varchar', { name: 'reference_external_transaction_id', nullable: true, length: 256 })
  referenceExternalTransactionId!: string | null;

  @Column('uuid', { name: 'reference_transaction_id', nullable: true })
  referenceTransactionId!: string | null;

  @Column('text')
  status!: TransactionStatus;

  @Column('text', { name: 'failure_code', nullable: true })
  failureCode!: string | null;

  @Column('jsonb', { nullable: true })
  result!: WagerResult | null;

  @Column('integer', { default: 0 })
  attempts!: number;

  @Column('timestamptz', { name: 'next_attempt_at', nullable: true })
  nextAttemptAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'processed_at', nullable: true })
  processedAt!: Date | null;

  @Column('text', { name: 'correlation_id' })
  correlationId!: string;
}
