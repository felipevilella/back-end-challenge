import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { LedgerDirection } from '../../module/domains/wager-transaction';

@Entity('wallet_ledger')
export class WalletLedgerEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'wallet_id' })
  walletId!: string;

  @Column('uuid', { name: 'transaction_id' })
  transactionId!: string;

  @Column('text')
  direction!: LedgerDirection;

  @Column('numeric', { precision: 20, scale: 2 })
  amount!: string;

  @Column('varchar', { length: 3 })
  currency!: string;

  @Column('numeric', { name: 'balance_before', precision: 20, scale: 2 })
  balanceBefore!: string;

  @Column('numeric', { name: 'balance_after', precision: 20, scale: 2 })
  balanceAfter!: string;

  @Column('integer', { name: 'wallet_version' })
  walletVersion!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
