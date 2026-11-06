import { Global, Injectable, Module } from '@nestjs/common';

@Injectable()
export class Telemetry {
  private readonly counters = new Map<string, number>();

  private lag = 0;

  increment(name: string, labels = ''): void {
    const key = `wager_${name}${labels ? `{${labels}}` : ''}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observeLatency(seconds: number): void {
    this.counters.set(
      'wager_processing_seconds_sum',
      (this.counters.get('wager_processing_seconds_sum') ?? 0) + seconds,
    );
    this.increment('processing_seconds_count');
  }

  setOutboxLag(seconds: number): void {
    this.lag = seconds;
  }

  log(event: string, context: Record<string, unknown>): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...context }));
  }

  render(): string {
    return (
      [...this.counters.entries()].map(([key, value]) => `${key} ${value}`).join('\n') +
      `\nwager_outbox_lag_seconds ${this.lag}\n`
    );
  }
}

@Global()
@Module({ providers: [Telemetry], exports: [Telemetry] })
export class ObservabilityModule {}
