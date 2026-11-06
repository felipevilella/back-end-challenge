import 'reflect-metadata';
import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './module/app.module';
import { HttpErrorFilter } from './infra/observability/http-error.filter';
import { JsonLogger } from './infra/observability/json-logger';

export async function createApplication(quiet = false) {
  const app = await NestFactory.create(AppModule, { logger: quiet ? false : new JsonLogger() });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();

  return app;
}
