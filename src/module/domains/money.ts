import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const ExactDecimal = Decimal.clone({ precision: 40 });

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(props.amount)) {
      throw new Error('INVALID_MONEY_AMOUNT');
    }

    if (typeof props.currency !== 'string' || !/^[A-Z]{3}$/.test(props.currency)) {
      throw new Error('INVALID_CURRENCY');
    }
    // NUMERIC(20,2): never silently round or exceed the persistence range.
    if (new ExactDecimal(props.amount).gt('999999999999999999.99')) {
      throw new Error('MONEY_OVERFLOW');
    }

    return new Money(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error('CURRENCY_MISMATCH');
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.add(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.sub(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.neg(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.eq(other.value);
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }
}
