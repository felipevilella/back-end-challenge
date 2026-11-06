import type { IWalletsRepository } from '../../../repositories/wallets.repository.interface';
import { WalletMapper } from '../mapper/wallet.mapper';

export class GetWalletService {
  constructor(private readonly wallets: IWalletsRepository) {}

  async execute(id: string) {
    const wallet = await this.wallets.findById(id);

    return wallet ? WalletMapper.toDTO(wallet) : null;
  }
}
