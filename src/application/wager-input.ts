import { InvalidPayloadError } from '../domain/errors';
import { Money } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export interface WagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface ProcessMeta {
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
  source: 'http' | 'sqs';
  messageId?: string;
  payloadHash: string;
}

function text(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max) {
    throw new InvalidPayloadError(`${field} inválido`);
  }
  return value.trim();
}

export function parseWagerInput(body: unknown): WagerInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidPayloadError('corpo inválido');
  }
  const raw = body as Record<string, unknown>;
  const kind = text(raw.kind, 'kind', 16);
  if (kind === WagerTransactionKind.Opening) throw new InvalidPayloadError('OPENING não entra por aqui');
  if (!KINDS.has(kind)) throw new InvalidPayloadError('kind inválido');
  const playerId = text(raw.playerId, 'playerId', 64);
  const walletId = text(raw.walletId, 'walletId', 64);
  if (!UUID.test(playerId) || !UUID.test(walletId)) throw new InvalidPayloadError('id precisa ser uuid');
  const moneyRaw = raw.money;
  if (moneyRaw === null || typeof moneyRaw !== 'object') throw new InvalidPayloadError('money inválido');
  const money = Money.from(moneyRaw as { amount: string; currency: string });
  if (!money.isPositive()) throw new InvalidPayloadError('valor precisa ser positivo');
  let reference: string | undefined;
  if (raw.referenceExternalTransactionId !== undefined && raw.referenceExternalTransactionId !== null) {
    reference = text(raw.referenceExternalTransactionId, 'referenceExternalTransactionId');
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
    throw new InvalidPayloadError('REFUND e ROLLBACK precisam de referência');
  }
  return {
    providerId: text(raw.providerId, 'providerId'),
    externalTransactionId: text(raw.externalTransactionId, 'externalTransactionId'),
    playerId,
    walletId,
    roundId: text(raw.roundId, 'roundId'),
    gameId: text(raw.gameId, 'gameId'),
    kind: kind as WagerTransactionKind,
    money: money.toJSON(),
    referenceExternalTransactionId: reference,
  };
}

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidPayloadError('Idempotency-Key é obrigatório');
  const key = value.trim();
  if (key === '' || key.length > 200 || /[\r\n]/.test(key)) {
    throw new InvalidPayloadError('Idempotency-Key inválido');
  }
  return key;
}

export function parseSqsEnvelope(body: string): {
  input: WagerInput;
  idempotencyKey: string;
  messageId: string;
  occurredAt?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidPayloadError('mensagem SQS não é JSON');
  }
  if (parsed === null || typeof parsed !== 'object') throw new InvalidPayloadError('envelope inválido');
  const envelope = parsed as Record<string, unknown>;
  if (envelope.type !== 'WagerTransactionRequested') throw new InvalidPayloadError('type inesperado');
  const data = envelope.data;
  if (data === null || typeof data !== 'object') throw new InvalidPayloadError('data ausente');
  const record = data as Record<string, unknown>;
  const input = parseWagerInput(record);
  const idempotencyKey = parseIdempotencyKey(record.idempotencyKey);
  const messageId =
    typeof envelope.messageId === 'string' && envelope.messageId.trim() !== ''
      ? envelope.messageId.trim()
      : '';
  if (messageId === '') throw new InvalidPayloadError('messageId ausente');
  return {
    input,
    idempotencyKey,
    messageId,
    occurredAt: typeof envelope.occurredAt === 'string' ? envelope.occurredAt : undefined,
  };
}
