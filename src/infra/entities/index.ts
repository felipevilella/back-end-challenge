import { InboxMessageEntity } from './inbox-message.entity';
import { OutboxMessageEntity } from './outbox-message.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';
import { WalletLedgerEntity } from './wallet-ledger.entity';
import { WalletEntity } from './wallet.entity';

export const persistenceEntities = [
  WalletEntity,
  WagerTransactionEntity,
  WalletLedgerEntity,
  InboxMessageEntity,
  OutboxMessageEntity,
];
