import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { JsonLogger } from './infra/observability/json-logger';
import { AppModule } from './module/app.module';

process.env.RUN_WORKERS = 'true';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: new JsonLogger() });
  app.enableShutdownHooks();
}

bootstrap().catch(() => {
  console.error(JSON.stringify({ level: 'error', event: 'worker_startup_failed' }));
  process.exitCode = 1;
});
