import { Injectable } from '@nestjs/common';

@Injectable()
export class EnvironmentConfigService {
  get databaseUrl(): string {
    const value = process.env.DATABASE_URL;
    if (!value) {
      throw new Error('DATABASE_URL is required');
    }

    return value;
  }

  get port(): number {
    const port = Number(process.env.PORT ?? '3000');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid PORT');
    }

    return port;
  }
}
