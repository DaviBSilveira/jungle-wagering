import { describe, expect, test } from 'bun:test';
import { UnbalancedLedgerError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-07-29T15:00:00.000Z');

describe('WalletLedgerEntry', () => {
  test('débito fecha a conta', () => {
    const entry = WalletLedgerEntry.create({
      id: '1',
      walletId: 'w',
      transactionId: 't',
      direction: LedgerDirection.Debit,
      money: brl('80.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('20.00'),
      createdAt: now,
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('recusa lançamento que não bate ou zera', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: '1',
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00'),
        createdAt: now,
      }),
    ).toThrow(UnbalancedLedgerError);
    expect(() =>
      WalletLedgerEntry.create({
        id: '1',
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00'),
        createdAt: now,
      }),
    ).toThrow(UnbalancedLedgerError);
  });
});
