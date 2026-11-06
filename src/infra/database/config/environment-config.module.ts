import { Global, Module } from '@nestjs/common';
import { EnvironmentConfigService } from './environment-config.service';
@Global()
@Module({ providers: [EnvironmentConfigService], exports: [EnvironmentConfigService] })
export class EnvironmentConfigModule {}
