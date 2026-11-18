export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletMismatch = "WALLET_MISMATCH",
  InvalidReference = "INVALID_REFERENCE",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotReady = "REFERENCE_NOT_READY",
  ReferenceTypeNotAllowed = "REFERENCE_TYPE_NOT_ALLOWED",
  AmountMismatch = "AMOUNT_MISMATCH",
  AlreadyReversed = "ALREADY_REVERSED",
  ProcessingFailed = "PROCESSING_FAILED",
  InvalidTransactionState = "INVALID_TRANSACTION_STATE",
  InvalidTransaction = "INVALID_TRANSACTION",
  InvalidMoney = "INVALID_MONEY",
  InvalidWalletState = "INVALID_WALLET_STATE",
  InvalidLedgerEntry = "INVALID_LEDGER_ENTRY",
  InvalidMessage = "INVALID_MESSAGE",
  InvalidMessageState = "INVALID_MESSAGE_STATE",
  InvalidEvent = "INVALID_EVENT",
}

export type RejectionCode =
  | FailureCode.InsufficientFunds
  | FailureCode.ReversalInsufficientFunds
  | FailureCode.CurrencyMismatch
  | FailureCode.WalletMismatch
  | FailureCode.InvalidReference
  | FailureCode.ReferenceNotFound
  | FailureCode.ReferenceTypeNotAllowed
  | FailureCode.AmountMismatch
  | FailureCode.AlreadyReversed;
