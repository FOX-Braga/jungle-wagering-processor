import { expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import {
  CurrencyMismatchError,
  DomainInvariantError,
} from "../../../src/domain/shared/domain-errors";
import { FailureCode } from "../../../src/domain/shared/failure-code";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

test.each(["25.00", "0.00", "0.01", "1000000.00", "900719925474099312345678901234567890.01"])(
  "round-trips %s precisely",
  (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: "BRL" });
  },
);

test.each([
  "",
  "NaN",
  "Infinity",
  "1e3",
  "0.001",
  "1",
  "1.0",
  "1.00\n",
  " 1.00",
  "+1.00",
  "-0.00",
  "-1.00",
])("rejects the external amount %j", (amount) => {
  expect(() => brl(amount)).toThrow(DomainInvariantError);
});

test("rejects numeric input and unsupported currency codes", () => {
  expect(() => brl(0.1 as unknown as string)).toThrow(DomainInvariantError);
  for (const currency of ["ZZZ", "brl", "BR", " USD", "USD\n"]) {
    expect(() => Money.zero(currency)).toThrow(DomainInvariantError);
  }
  try {
    brl("bad");
  } catch (error) {
    expect(error).toMatchObject({ code: FailureCode.InvalidMoney });
  }
});

test("adds, subtracts, compares and negates without mutating either operand", () => {
  const a = brl("0.10");
  const b = brl("0.20");
  const sum = a.add(b);
  const difference = a.subtract(b);
  expect(sum.toString()).toBe("0.30");
  expect(difference.toString()).toBe("-0.10");
  expect(difference.isNegative()).toBe(true);
  expect(a.negate().equals(difference)).toBe(true);
  expect(a.isLessThan(b)).toBe(true);
  expect(b.isPositive()).toBe(true);
  expect(a.equals(brl("00.10"))).toBe(true);
  expect(a.equals(b)).toBe(false);
  expect(a.toString()).toBe("0.10");
  expect(b.toString()).toBe("0.20");
  expect(sum).not.toBe(a);
  expect(difference).not.toBe(a);
  expect(a.negate()).not.toBe(a);
  expect(a.add(Money.zero("BRL"))).not.toBe(a);
  expect(Money.zero("BRL").negate().isZero()).toBe(true);
  expect(Object.isFrozen(a)).toBe(true);
});

test("does not lose a cent when an addition carries beyond a large integer", () => {
  expect(brl("99999999999999999999999999999999999999.99").add(brl("0.01")).toString()).toBe(
    "100000000000000000000000000000000000000.00",
  );
});

test("rejects every cross-currency arithmetic operation and comparison", () => {
  const a = brl("1.00");
  const b = Money.from({ amount: "1.00", currency: "USD" });
  expect(() => a.add(b)).toThrow(CurrencyMismatchError);
  expect(() => a.subtract(b)).toThrow(CurrencyMismatchError);
  expect(() => a.isLessThan(b)).toThrow(CurrencyMismatchError);
  expect(() => a.equals(b)).toThrow(CurrencyMismatchError);
});
