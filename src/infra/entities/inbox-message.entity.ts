import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('inbox_messages')
export class InboxMessageEntity {
  @PrimaryColumn('text', { name: 'consumer_name' })
  consumerName!: string;

  @PrimaryColumn('varchar', { name: 'message_id', length: 256 })
  messageId!: string;

  @Column('char', { name: 'payload_hash', length: 64 })
  payloadHash!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'received_at' })
  receivedAt!: Date;

  @Column('timestamptz', { name: 'processed_at', nullable: true })
  processedAt!: Date | null;
}
