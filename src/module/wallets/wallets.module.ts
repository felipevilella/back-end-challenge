import { Module } from '@nestjs/common';
import { UseCaseProxyModule } from '../../infra/usecase-proxy/usecase-proxy.module';
import { WalletsController } from './wallets.controller';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
@Module({ imports: [UseCaseProxyModule.register()], controllers: [WalletsController], providers: [ProviderAuthGuard] })
export class WalletsModule {}
