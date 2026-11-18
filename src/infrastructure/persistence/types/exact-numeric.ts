import { Type } from "@mikro-orm/core";
import { Money } from "../../../domain/money/money";

const persistedAmount = /^\d{1,36}\.\d{2}(?![\s\S])/;
const numericText = /^(-?)(\d+)(?:\.(\d{1,2}))?(?![\s\S])/;

function decimalText(value: string): string {
  if (typeof value !== "string") throw new TypeError("PostgreSQL NUMERIC must arrive as text");
  const match = numericText.exec(value);
  if (!match) throw new RangeError("Invalid money scale returned by PostgreSQL");
  const [, sign, integer, cents] = match;
  return `${sign}${integer}.${(cents ?? "").padEnd(2, "0")}`;
}

export function toStoredMoney(money: Money): string {
  const value = money.toString();
  if (!persistedAmount.test(value))
    throw new RangeError("Money exceeds the PostgreSQL range or scale");
  return value;
}

export function fromStoredMoney(value: string, currency: string): Money {
  const amount = decimalText(value);
  if (!amount.startsWith("-")) return Money.from({ amount, currency });
  return Money.from({ amount: amount.slice(1), currency }).negate();
}

export class ExactNumericType extends Type<string | null, string | null> {
  override convertToDatabaseValue(value: string | null): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || !persistedAmount.test(value))
      throw new RangeError("Invalid stored money amount");
    return value;
  }

  override convertToJSValue(value: string | null): string | null {
    if (value === null) return null;
    const normalized = decimalText(value);
    if (!persistedAmount.test(normalized)) throw new RangeError("Invalid stored money amount");
    return normalized;
  }

  override convertToJSValueSQL(column: string): string {
    return `cast(${column} as text)`;
  }

  override getColumnType(): string {
    return "wagering.money_amount";
  }

  override compareAsType(): string {
    return "string";
  }
}
