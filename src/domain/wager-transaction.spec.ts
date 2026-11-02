import { describe, expect, test } from 'bun:test';
import { FailureCode, InvalidPayloadError, InvalidTransactionStateError } from './errors';
import { LedgerDirection } from './ledger';
import { Money } from './money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

const now = new Date('2026-07-29T15:00:00.000Z');

function bet(kind: WagerTransactionKind = WagerTransactionKind.Bet, reference?: string) {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'hash-a',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: reference,
    createdAt: now,
  });
}

describe('WagerTransaction', () => {
  test('nasce pending e trava quando chega num estado terminal', () => {
    const tx = bet();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.affectsBalance()).toBe(true);
    tx.markProcessed(undefined, now);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.InsufficientBalance)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ReferenceNotFound)).toThrow(InvalidTransactionStateError);
  });

  test('LOSS não mexe saldo e refund sem referência nem nasce', () => {
    const loss = bet(WagerTransactionKind.Loss);
    expect(loss.affectsBalance()).toBe(false);
    expect(() => bet(WagerTransactionKind.Refund)).toThrow(InvalidPayloadError);
    expect(() => bet(WagerTransactionKind.Opening)).toThrow(InvalidPayloadError);
  });

  test('direção do rollback é o inverso da referência', () => {
    const rollback = bet(WagerTransactionKind.Rollback, 'transaction-bet');
    const win = bet(WagerTransactionKind.Win);
    expect(rollback.requiresReference()).toBe(true);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.matchesPayload('hash-a')).toBe(true);
    expect(rollback.matchesPayload('hash-b')).toBe(false);
  });

  test('pending reference ainda pode ser resolvida', () => {
    const tx = bet(WagerTransactionKind.Refund, 'transaction-bet');
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    tx.markProcessed('ref-interna', now);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-interna');
  });
});
