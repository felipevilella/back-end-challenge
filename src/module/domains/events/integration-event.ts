export interface EventContext {
  aggregateId: string;
  correlationId: string;
  causationId?: string;
}

export abstract class IntegrationEvent<T extends Record<string, unknown>> {
  abstract readonly eventType: string;

  readonly version = 1;

  protected constructor(
    readonly eventId: string,
    readonly context: EventContext,
    readonly data: Readonly<T>,
    readonly occurredAt: Date,
  ) {}

  toJSON() {
    return {
      eventId: this.eventId,
      ...this.context,
      eventType: this.eventType,
      version: this.version,
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionProcessed';

  static create(id: string, ctx: EventContext, data: Record<string, unknown>) {
    return new this(id, ctx, data, new Date());
  }
}

export class WagerTransactionRejected extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionRejected';

  static create(id: string, ctx: EventContext, data: Record<string, unknown>) {
    return new this(id, ctx, data, new Date());
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionPendingReference';

  static create(id: string, ctx: EventContext, data: Record<string, unknown>) {
    return new this(id, ctx, data, new Date());
  }
}

export class WalletBalanceChanged extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WalletBalanceChanged';

  static create(id: string, ctx: EventContext, data: Record<string, unknown>) {
    return new this(id, ctx, data, new Date());
  }
}

export class WagerTransactionFailed extends IntegrationEvent<Record<string, unknown>> {
  readonly eventType = 'WagerTransactionFailed';

  static create(id: string, ctx: EventContext, data: Record<string, unknown>) {
    return new this(id, ctx, data, new Date());
  }
}
