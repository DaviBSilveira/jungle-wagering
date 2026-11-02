export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}
export class CurrencyMismatchError extends DomainError {}
export class InsufficientBalanceError extends DomainError {}
export class InvalidTransactionStateError extends DomainError {}
export class UnbalancedLedgerError extends DomainError {}
export class InvalidPayloadError extends DomainError {}
export class IdempotencyConflictError extends DomainError {}
export class DuplicateWalletError extends DomainError {}
export class WalletNotFoundError extends DomainError {}
export class TransactionNotFoundError extends DomainError {}

export const FailureCode = {
  InsufficientBalance: 'INSUFFICIENT_BALANCE',
  NegativeBalanceOnReversal: 'NEGATIVE_BALANCE_ON_REVERSAL',
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  AmountMismatch: 'AMOUNT_MISMATCH',
  AlreadyReversed: 'ALREADY_REVERSED',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  PlayerMismatch: 'PLAYER_MISMATCH',
  OpeningNotAllowed: 'OPENING_NOT_ALLOWED',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
