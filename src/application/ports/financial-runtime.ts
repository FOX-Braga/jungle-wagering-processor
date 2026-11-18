export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface FinancialRuntime {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
