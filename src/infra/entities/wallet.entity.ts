import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('wallets')
@Index(['playerId', 'currency'], { unique: true })
export class WalletEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'player_id' })
  playerId!: string;

  @Column('varchar', { length: 3 })
  currency!: string;

  @Column('numeric', { precision: 20, scale: 2 })
  balance!: string;

  @Column('integer')
  version!: number;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'updated_at' })
  updatedAt!: Date;
}
