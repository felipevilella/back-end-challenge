import type {
  WagerCommand,
  TransactionKind,
  TransactionStatus,
  LedgerDirection,
} from '../module/domains/wager-transaction';
import type { MoneyProps } from '../module/domains/money';

export interface ProcessingContext {
  correlationId: string;
  causationId?: string;
  inbox?: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
  };
}

export interface WagerResult {
  transactionId: string;
  status: TransactionStatus;
  balance: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface TransactionView extends WagerResult {
  providerId: string;
  externalTransactionId: string;
  kind: TransactionKind;
  money: MoneyProps;
  referenceTransactionId: string | null;
  referenceExternalTransactionId: string | null;
  createdAt: Date;
}
// Preserve the existing HTTP ledger representation while mapping ORM entities explicitly.
export interface LedgerEntryView {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
  created_at: Date;
}

export interface LedgerPage {
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export interface PendingReference {
  id: string;
  walletId: string;
  providerId: string;
  correlationId: string;
}

export interface IFinancialRepository {
  process(command: WagerCommand, hash: string, context: ProcessingContext): Promise<WagerResult>;
  createWallet(
    playerId: string,
    balance: MoneyProps,
    context: ProcessingContext,
  ): Promise<WalletView>;
  findTransaction(id: string): Promise<TransactionView | null>;
  findExternal(providerId: string, externalId: string): Promise<TransactionView | null>;
  ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;
  reconcile(walletId: string): Promise<ReconciliationResult>;
}
