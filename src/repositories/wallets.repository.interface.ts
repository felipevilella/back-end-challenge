import { Wallet } from '../module/domains/wallet';
export interface IWalletsRepository { findById(id: string): Promise<Wallet | null> }
