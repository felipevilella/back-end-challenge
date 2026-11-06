import { Module } from '@nestjs/common';
import { UseCaseProxyModule } from '../../infra/usecase-proxy/usecase-proxy.module';
import { WageringController } from './wagering.controller';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';

@Module({
  imports: [UseCaseProxyModule.register()],
  controllers: [WageringController],
  providers: [ProviderAuthGuard],
})
export class WageringModule {}
