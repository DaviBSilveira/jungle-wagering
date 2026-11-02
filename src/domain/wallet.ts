import { CurrencyMismatchError, InsufficientBalanceError, InvalidMoneyError } from './errors';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new InvalidMoneyError('saldo inicial negativo');
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money): void {
    this.apply(money, 'debit');
  }

  credit(money: Money): void {
    this.apply(money, 'credit');
  }

  private apply(money: Money, side: 'debit' | 'credit'): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new InvalidMoneyError('movimentação zerada ou negativa');
    if (side === 'debit' && this._balance.isLessThan(money)) throw new InsufficientBalanceError('saldo insuficiente');
    this._balance = side === 'debit' ? this._balance.subtract(money) : this._balance.add(money);
    this._version += 1;
    this._updatedAt = new Date();
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError('moeda da operação diferente da wallet');
    }
  }
}
