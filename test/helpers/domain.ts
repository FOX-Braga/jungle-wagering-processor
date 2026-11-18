import { Money } from "../../src/domain/money/money";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const at = (offset = 0) => new Date(Date.UTC(2026, 10, 18) + offset);
