import type { LoggerService } from '@nestjs/common';

export class JsonLogger implements LoggerService {
  private write(level: string, message: unknown, context?: string): void {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        context,
        message: typeof message === 'string' ? message : 'Framework event',
      }),
    );
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  error(_message: unknown, _trace?: string, context?: string): void {
    this.write('error', 'Framework operation failed', context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
}
