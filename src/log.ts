const blocked = new Set([
  'amount',
  'money',
  'balance',
  'payload',
  'authorization',
  'password',
  'secret',
  'token',
]);

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (blocked.has(key.toLowerCase())) continue;
    safe[key] = value;
  }
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...safe });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export function errorFields(err: unknown): { error: string; code?: string } {
  const code = sqlState(err);
  const message = err instanceof Error ? err.message.slice(0, 240) : 'erro';
  return code ? { error: message, code } : { error: message };
}

export function sqlState(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && /^[0-9A-Z]{5}$/.test(record.code)) return record.code;
    current = record.cause;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return sqlState(err) === '23505' || (err instanceof Error && err.name === 'UniqueConstraintViolationException');
}

const transientStates = new Set(['40001', '40P01', '55P03', '08000', '08003', '08006', '57P01', '53300']);

export function isTransientError(err: unknown): boolean {
  const state = sqlState(err);
  if (state && transientStates.has(state)) return true;
  const message = err instanceof Error ? err.message : '';
  return /ECONNREFUSED|ETIMEDOUT|Connection terminated|timeout|EAI_AGAIN/i.test(message);
}
