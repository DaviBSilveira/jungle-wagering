import { createHash } from 'crypto';
import { Money } from '../domain/money';
import type { WagerInput } from './wager-input';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Hash só do negócio. Header, messageId e correlationId ficam de fora.
export function wagerPayloadHash(input: WagerInput): string {
  const money = Money.from(input.money).toJSON();
  const payload: Record<string, unknown> = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money,
    playerId: input.playerId,
    providerId: input.providerId,
    roundId: input.roundId,
    walletId: input.walletId,
  };
  if (input.referenceExternalTransactionId) {
    payload.referenceExternalTransactionId = input.referenceExternalTransactionId;
  }
  return sha256(canonicalJson(payload));
}
