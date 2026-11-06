import { Module } from '@nestjs/common';
import { EnvironmentConfigModule } from '../infra/database/config/environment-config.module';
import { TypeOrmConfigModule } from '../infra/database/typeorm/typeorm.module';
import { WalletsModule } from './wallets/wallets.module';
import { HealthModule } from './health/health.module';
@Module({ imports: [EnvironmentConfigModule, TypeOrmConfigModule, WalletsModule, HealthModule] })
export class AppModule {}
