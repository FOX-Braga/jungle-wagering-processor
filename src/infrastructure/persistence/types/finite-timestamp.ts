import { Type } from "@mikro-orm/core";

export class FiniteTimestampType extends Type<Date | null, Date | string | null> {
  override convertToDatabaseValue(value: Date | null): string | null {
    return value === null ? null : value.toISOString();
  }

  override convertToJSValue(value: Date | string | null): Date | null {
    if (value === null) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid PostgreSQL timestamp");
    return date;
  }

  override convertToJSValueSQL(column: string): string {
    return `cast(${column} as timestamptz)`;
  }

  override getColumnType(): string {
    return "wagering.finite_time";
  }

  override compareAsType(): string {
    return "date";
  }
}
