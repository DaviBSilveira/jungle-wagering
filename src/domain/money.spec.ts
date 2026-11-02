import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('soma 0.10 com 0.20 e não cai na pegadinha do float', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });

  test('normaliza 10 e 10.5 para duas casas', () => {
    expect(brl('10').equals(brl('10.00'))).toBe(true);
    expect(brl('10.5').toJSON().amount).toBe('10.50');
  });

  test('rejeita o que eu não quero arredondar em silêncio', () => {
    const bad = ['10.555', '1e2', '1E2', '', 'NaN', 'Infinity', '-1.00', '10.001', '  ', 'abc', '10.5.1'];
    for (const amount of bad) {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    }
    expect(() => Money.from({ amount: '10.00', currency: 'BR' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('moeda diferente estoura e a instância original não muda', () => {
    const original = brl('25.00');
    original.add(brl('1.00'));
    expect(original.toJSON().amount).toBe('25.00');
    expect(() => original.add(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow(CurrencyMismatchError);
  });

  test('subtrai, nega e compara', () => {
    expect(brl('20.00').subtract(brl('50.00')).isNegative()).toBe(true);
    expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(Money.zero('brl').isZero()).toBe(true);
    expect(brl('1.00').toString()).toBe('1.00 BRL');
  });

  test('valor grande continua exato', () => {
    const value = brl('99999999999999.99');
    expect(value.add(brl('0.01')).toJSON().amount).toBe('100000000000000.00');
  });

  test('leitura do banco aceita zero à direita e recusa lixo', () => {
    expect(Money.fromPersisted('10.5000', 'BRL').toJSON().amount).toBe('10.50');
    expect(() => Money.fromPersisted('10.501', 'BRL')).toThrow(InvalidMoneyError);
  });
});
