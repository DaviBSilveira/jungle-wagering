import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientBalanceError } from './errors';
import { Money } from './money';
import { Wallet } from './wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function open(amount = '100.00') {
  return Wallet.open({
    id: '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    initialBalance: brl(amount),
  });
}

describe('Wallet', () => {
  test('abre na version 1 e só incrementa quando o saldo muda', () => {
    const wallet = open('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    wallet.debit(brl('25.00'));
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    wallet.credit(brl('5.00'));
    expect(wallet.version).toBe(3);
  });

  test('não deixa saldo negativo e não mexe na version se a aposta não cabe', () => {
    const wallet = open('20.00');
    expect(() => wallet.debit(brl('20.01'))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  test('recusa outra moeda', () => {
    const wallet = open();
    expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate não tenta "corrigir" o que já estava gravado', () => {
    const wallet = Wallet.rehydrate({
      id: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      currency: 'BRL',
      balance: brl('7.00'),
      version: 4,
      createdAt: new Date('2026-07-29T15:00:00.000Z'),
      updatedAt: new Date('2026-07-29T15:05:00.000Z'),
    });
    expect(wallet.version).toBe(4);
    expect(wallet.balance.toJSON().amount).toBe('7.00');
  });
});
