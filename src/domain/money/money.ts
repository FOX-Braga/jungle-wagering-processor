import { CurrencyMismatchError, DomainInvariantError } from "../shared/domain-errors";
import { FailureCode } from "../shared/failure-code";

export type MoneyProps = {
  readonly amount: string;
  readonly currency: string;
};

const currencies = new Set(Intl.supportedValuesOf("currency"));
const decimal = /^\d+\.\d{2}(?![\s\S])/;

export class Money {
  readonly #cents: bigint;

  private constructor(
    cents: bigint,
    public readonly currency: string,
  ) {
    this.#cents = cents;
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== "string" || !decimal.test(amount)) {
      throw new DomainInvariantError(
        FailureCode.InvalidMoney,
        "Amount must be a non-negative decimal string with two places",
      );
    }
    Money.validateCurrency(currency);
    return new Money(BigInt(amount.replace(".", "")), currency);
  }

  static zero(currency: string): Money {
    Money.validateCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#cents + other.#cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#cents - other.#cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.#cents, this.currency);
  }

  isZero(): boolean {
    return this.#cents === 0n;
  }

  isPositive(): boolean {
    return this.#cents > 0n;
  }

  isNegative(): boolean {
    return this.#cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#cents < other.#cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#cents === other.#cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const magnitude = (this.isNegative() ? -this.#cents : this.#cents).toString().padStart(3, "0");
    return `${this.isNegative() ? "-" : ""}${magnitude.slice(0, -2)}.${magnitude.slice(-2)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static validateCurrency(currency: string): void {
    if (!currencies.has(currency)) {
      throw new DomainInvariantError(FailureCode.InvalidMoney, "Unsupported ISO 4217 currency");
    }
  }
}
