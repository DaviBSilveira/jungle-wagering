import { randomBytes } from 'crypto';

export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 255n);
  bytes[1] = Number((ts >> 32n) & 255n);
  bytes[2] = Number((ts >> 24n) & 255n);
  bytes[3] = Number((ts >> 16n) & 255n);
  bytes[4] = Number((ts >> 8n) & 255n);
  bytes[5] = Number(ts & 255n);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const split = raw.lastIndexOf('|');
  if (split <= 0) throw new Error('cursor inválido');
  const createdAt = new Date(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) throw new Error('cursor inválido');
  return { createdAt, id };
}
