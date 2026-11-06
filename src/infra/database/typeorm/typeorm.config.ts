import 'dotenv/config';
import { DataSource } from 'typeorm';
import { WalletEntity } from '../../entities/wallet.entity';
import { InitialWallets1790000000000 } from './migrations/1790000000000-initial-wallets';
import { EnvironmentConfigService } from '../config/environment-config.service';
export const databaseOptions = () => ({
  type: 'postgres' as const,
  url: new EnvironmentConfigService().databaseUrl,
  entities: [WalletEntity], migrations: [InitialWallets1790000000000],
  synchronize: false, migrationsRun: false,
});
export default new DataSource(databaseOptions());
