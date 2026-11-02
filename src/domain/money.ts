import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Centavos em bigint. Não passa por number em nenhum cálculo.
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money inválido');
    }
    return new Money(parseInputMinor(props.amount), normalizeCurrency(props.currency));
  }

  static fromPersisted(amount: string, currency: string): Money {
    return new Money(parsePersistedMinor(amount), normalizeCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, normalizeCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: formatMinor(this.minor), currency: this.currency };
  }

  toString(): string {
    return `${formatMinor(this.minor)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`${this.currency} e ${other.currency} não fecham conta juntos`);
    }
  }
}

function normalizeCurrency(currency: string): string {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) {
    throw new InvalidMoneyError('moeda inválida');
  }
  return currency.trim().toUpperCase();
}

function parseInputMinor(amount: unknown): bigint {
  if (typeof amount !== 'string') throw new InvalidMoneyError('amount precisa ser string');
  const trimmed = amount.trim();
  if (trimmed === '' || /e/i.test(trimmed) || trimmed === 'NaN' || trimmed === 'Infinity') {
    throw new InvalidMoneyError('amount inválido');
  }
  if (trimmed.startsWith('-')) throw new InvalidMoneyError('amount negativo não entra no contrato');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) throw new InvalidMoneyError('amount inválido');
  const whole = trimmed.split('.')[0];
  if (whole.length > 16) throw new InvalidMoneyError('amount fora da escala');
  return minorFromParts(trimmed, false);
}

function parsePersistedMinor(amount: string): bigint {
  const trimmed = String(amount).trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new InvalidMoneyError('valor persistido inválido');
  const frac = match[3] ?? '';
  if (frac.length > 2 && /[^0]/.test(frac.slice(2))) {
    throw new InvalidMoneyError('valor persistido com escala quebrada');
  }
  const normalized = `${match[2]}.${frac.slice(0, 2)}`;
  return minorFromParts(normalized, match[1] === '-');
}

function minorFromParts(amount: string, negative: boolean): bigint {
  const [whole, frac = ''] = amount.split('.');
  const cents = (frac + '00').slice(0, 2);
  const minor = BigInt(whole) * 100n + BigInt(cents);
  return negative ? -minor : minor;
}

function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}
