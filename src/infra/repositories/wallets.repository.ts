import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { IWalletsRepository } from '../../repositories/wallets.repository.interface';
import { WalletEntity } from '../entities/wallet.entity';
import { WalletMapper } from '../../module/wallets/mapper/wallet.mapper';

@Injectable()
export class WalletsRepository implements IWalletsRepository {
  constructor(
    @InjectRepository(WalletEntity)
    private readonly repository: Repository<WalletEntity>,
  ) {}

  async findById(id: string) {
    const row = await this.repository.findOneBy({ id });

    return row ? WalletMapper.toDomain(row) : null;
  }
}
