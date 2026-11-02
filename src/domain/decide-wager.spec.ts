import { describe, expect, test } from 'bun:test';
import { decideWager, type ReferenceView } from './decide-wager';
import { FailureCode } from './errors';
import { LedgerDirection } from './ledger';
import { Money } from './money';
import { WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function input(kind: WagerTransactionKind, amount: string, reference?: string) {
  return {
    kind,
    money: brl(amount),
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-987',
    providerId: 'provider-a',
    referenceExternalTransactionId: reference,
  };
}

function wallet(amount = '100.00') {
  return { playerId: PLAYER, currency: 'BRL', balance: brl(amount) };
}

function reference(overrides: Partial<ReferenceView> = {}): ReferenceView {
  return {
    id: 'ref-1',
    providerId: 'provider-a',
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-987',
    currency: 'BRL',
    kind: WagerTransactionKind.Bet,
    status: WagerTransactionStatus.Processed,
    money: brl('25.00'),
    ...overrides,
  };
}

describe('decideWager', () => {
  test('BET debita, recusa saldo curto e LOSS não mexe no saldo', () => {
    expect(decideWager(input(WagerTransactionKind.Bet, '25.00'), wallet(), null, false)).toEqual({
      outcome: 'processed',
      direction: LedgerDirection.Debit,
    });
    expect(decideWager(input(WagerTransactionKind.Bet, '80.00'), wallet('20.00'), null, false).outcome).toBe('rejected');
    const loss = decideWager(input(WagerTransactionKind.Loss, '25.00'), wallet(), null, false);
    expect(loss).toEqual({ outcome: 'processed', direction: null });
  });

  test('WIN credita, e com referência ausente fica pendente', () => {
    expect(decideWager(input(WagerTransactionKind.Win, '40.00'), wallet(), null, false).outcome).toBe('processed');
    expect(decideWager(input(WagerTransactionKind.Win, '40.00', 'bet-1'), wallet(), null, false).outcome).toBe(
      'pending_reference',
    );
    const badRound = decideWager(
      input(WagerTransactionKind.Win, '40.00', 'bet-1'),
      wallet(),
      reference({ roundId: 'outra' }),
      false,
    );
    expect(badRound).toEqual({ outcome: 'rejected', code: FailureCode.ReferenceMismatch });
  });

  test('REFUND e ROLLBACK', () => {
    expect(decideWager(input(WagerTransactionKind.Refund, '25.00', 'bet-1'), wallet(), null, false).outcome).toBe(
      'pending_reference',
    );
    expect(
      decideWager(input(WagerTransactionKind.Refund, '25.00', 'bet-1'), wallet(), reference(), false),
    ).toEqual({ outcome: 'processed', direction: LedgerDirection.Credit });
    expect(
      decideWager(input(WagerTransactionKind.Refund, '10.00', 'bet-1'), wallet(), reference(), false),
    ).toEqual({ outcome: 'rejected', code: FailureCode.AmountMismatch });
    expect(
      decideWager(input(WagerTransactionKind.Refund, '25.00', 'bet-1'), wallet(), reference(), true),
    ).toEqual({ outcome: 'rejected', code: FailureCode.AlreadyReversed });
    expect(
      decideWager(
        input(WagerTransactionKind.Rollback, '25.00', 'win-1'),
        wallet('10.00'),
        reference({ kind: WagerTransactionKind.Win }),
        false,
      ),
    ).toEqual({ outcome: 'rejected', code: FailureCode.NegativeBalanceOnReversal });
    expect(
      decideWager(input(WagerTransactionKind.Refund, '25.00', 'loss-1'), wallet(), reference({ kind: WagerTransactionKind.Loss }), false),
    ).toEqual({ outcome: 'rejected', code: FailureCode.InvalidReferenceKind });
  });

  test('jogador ou moeda errados não passam', () => {
    const otherPlayer = { ...input(WagerTransactionKind.Bet, '10.00'), playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' };
    expect(decideWager(otherPlayer, wallet(), null, false)).toEqual({
      outcome: 'rejected',
      code: FailureCode.PlayerMismatch,
    });
    const usd = {
      ...input(WagerTransactionKind.Bet, '10.00'),
      money: Money.from({ amount: '10.00', currency: 'USD' }),
    };
    expect(decideWager(usd, wallet(), null, false)).toEqual({
      outcome: 'rejected',
      code: FailureCode.CurrencyMismatch,
    });
  });
});
