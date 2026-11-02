import { describe, expect, test } from 'bun:test';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { canonicalJson, wagerPayloadHash } from './canonical';
import type { WagerInput } from './wager-input';

function input(amount = '25.00'): WagerInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: 'BRL' },
  };
}

describe('payload hash', () => {
  test('a ordem das chaves não muda o hash', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  test('10.5 e 10.50 são o mesmo payload, 10.51 não', () => {
    expect(wagerPayloadHash(input('10.5'))).toBe(wagerPayloadHash(input('10.50')));
    expect(wagerPayloadHash(input('10.50'))).not.toBe(wagerPayloadHash(input('10.51')));
  });

  test('referência entra no hash, metadado de transporte não tem onde entrar', () => {
    const withRef = { ...input(), referenceExternalTransactionId: 'bet-1' };
    expect(wagerPayloadHash(withRef)).not.toBe(wagerPayloadHash(input()));
  });
});
