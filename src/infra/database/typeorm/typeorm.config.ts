import 'dotenv/config';
import { DataSource } from 'typeorm';
import { persistenceEntities } from '../../entities';
import { InitialWallets1790000000000 } from './migrations/1790000000000-initial-wallets';
import { FinancialProcessing1790000001000 } from './migrations/1790000001000-financial-processing';
import { EnvironmentConfigService } from '../config/environment-config.service';

export const databaseOptions = () => ({
  type: 'postgres' as const,
  url: new EnvironmentConfigService().databaseUrl,
  entities: persistenceEntities,
  migrations: [InitialWallets1790000000000, FinancialProcessing1790000001000],
  synchronize: false,
  migrationsRun: false,
  extra: { max: 20, statement_timeout: 15000, lock_timeout: 5000 },
});

export default new DataSource(databaseOptions());
