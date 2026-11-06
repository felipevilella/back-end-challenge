import { Wallet } from '../../domains/wallet';
import { Money } from '../../domains/money';
import { WalletEntity } from '../../../infra/entities/wallet.entity';

export class WalletMapper {
  static toDomain(row: WalletEntity): Wallet {
    return Wallet.rehydrate({
      ...row,
      balance: Money.from({ amount: row.balance, currency: row.currency }),
    });
  }

  static toDTO(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
