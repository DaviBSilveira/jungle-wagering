import { FailureCode } from './errors';
import { LedgerDirection, ledgerDirectionFor } from './ledger';
import { Money } from './money';
import { WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

export interface DecideInput {
  kind: WagerTransactionKind;
  money: Money;
  playerId: string;
  walletId: string;
  roundId: string;
  providerId: string;
  referenceExternalTransactionId?: string;
}

export interface ReferenceView {
  id: string;
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  currency: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: Money;
}

export type Decision =
  | { outcome: 'processed'; direction: LedgerDirection | null }
  | { outcome: 'rejected'; code: FailureCode }
  | { outcome: 'pending_reference' };

function rejected(code: FailureCode): Decision {
  return { outcome: 'rejected', code };
}

function waitsForReference(input: DecideInput): boolean {
  if (input.kind === WagerTransactionKind.Refund || input.kind === WagerTransactionKind.Rollback) return true;
  return input.kind === WagerTransactionKind.Win && Boolean(input.referenceExternalTransactionId);
}

function kindMatches(kind: WagerTransactionKind, referenceKind: WagerTransactionKind): boolean {
  if (kind === WagerTransactionKind.Refund) return referenceKind === WagerTransactionKind.Bet;
  if (kind === WagerTransactionKind.Rollback) {
    return (
      referenceKind === WagerTransactionKind.Bet ||
      referenceKind === WagerTransactionKind.Win ||
      referenceKind === WagerTransactionKind.Refund
    );
  }
  if (kind === WagerTransactionKind.Win) return referenceKind === WagerTransactionKind.Bet;
  return true;
}

export function decideWager(
  input: DecideInput,
  wallet: { playerId: string; currency: string; balance: Money },
  reference: ReferenceView | null,
  alreadyReversed: boolean,
): Decision {
  if (input.kind === WagerTransactionKind.Opening) return rejected(FailureCode.OpeningNotAllowed);
  if (input.playerId !== wallet.playerId) return rejected(FailureCode.PlayerMismatch);
  if (input.money.currency !== wallet.currency) return rejected(FailureCode.CurrencyMismatch);

  if (waitsForReference(input)) {
    if (!reference) return { outcome: 'pending_reference' };
    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { outcome: 'pending_reference' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) return rejected(FailureCode.ReferenceNotProcessed);
    const sameScope =
      reference.playerId === input.playerId &&
      reference.walletId === input.walletId &&
      reference.roundId === input.roundId &&
      reference.currency === input.money.currency &&
      reference.providerId === input.providerId;
    if (!sameScope) return rejected(FailureCode.ReferenceMismatch);
    if (!kindMatches(input.kind, reference.kind)) return rejected(FailureCode.InvalidReferenceKind);
    if (input.kind !== WagerTransactionKind.Win && !input.money.equals(reference.money)) {
      return rejected(FailureCode.AmountMismatch);
    }
    // REFUND e ROLLBACK da mesma BET creditariam duas vezes. Travo os dois.
    if (
      (input.kind === WagerTransactionKind.Refund || input.kind === WagerTransactionKind.Rollback) &&
      alreadyReversed
    ) {
      return rejected(FailureCode.AlreadyReversed);
    }
  }

  const direction = ledgerDirectionFor(input.kind, reference?.kind);
  if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(input.money)) {
    const code =
      input.kind === WagerTransactionKind.Rollback
        ? FailureCode.NegativeBalanceOnReversal
        : FailureCode.InsufficientBalance;
    return rejected(code);
  }
  return { outcome: 'processed', direction };
}
