import 'reflect-metadata';
import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './module/app.module';
import { EnvironmentConfigService } from './infra/database/config/environment-config.service';
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(app.get(EnvironmentConfigService).port);
}
bootstrap().catch(() => { console.error('Application startup failed; check dependency configuration'); process.exitCode = 1; });
