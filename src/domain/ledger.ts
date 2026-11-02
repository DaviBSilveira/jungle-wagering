import { UnbalancedLedgerError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
    if (!props.money.isPositive()) throw new UnbalancedLedgerError('lançamento precisa ter valor');
    if (!entry.isBalanced()) throw new UnbalancedLedgerError('lançamento não fecha');
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerError('lançamento com saldo negativo');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const after =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return after.equals(this.balanceAfter);
  }
}

export function ledgerDirectionFor(
  kind: string,
  referenceKind?: string,
): LedgerDirection | null {
  if (kind === 'LOSS') return null;
  if (kind === 'BET') return LedgerDirection.Debit;
  if (kind === 'WIN' || kind === 'REFUND' || kind === 'OPENING') return LedgerDirection.Credit;
  if (kind === 'ROLLBACK') {
    if (referenceKind === 'BET') return LedgerDirection.Credit;
    if (referenceKind === 'WIN' || referenceKind === 'REFUND') return LedgerDirection.Debit;
  }
  return null;
}
