import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { MikroORM } from '@mikro-orm/postgresql';
import { uuidv7 } from '../../src/application/ids';
import { ormConfig } from '../../src/infrastructure/db/orm';

const children: ChildProcess[] = [];

async function waitOk(url: string) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`não respondeu: ${url}`);
}

function start(port: number, id: string) {
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), INSTANCE_ID: id, WORKERS_ENABLED: 'true' },
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

afterAll(() => {
  for (const child of children) child.kill();
});

describe('três instâncias', () => {
  test(
    'o saldo continua batendo com o ledger',
    async () => {
      let probe: MikroORM;
      try {
        probe = await MikroORM.init(ormConfig());
        await probe.em.getConnection().execute('select 1');
        await probe.close(true);
      } catch (err) {
        throw new Error(`sem postgres para o teste de instâncias: ${err instanceof Error ? err.message : err}`);
      }

      const ports = [3311, 3312, 3313];
      ports.forEach((port, index) => start(port, `api-${index + 1}`));
      await Promise.all(ports.map((port) => waitOk(`http://127.0.0.1:${port}/health/live`)));

      const playerId = uuidv7();
      const created = await fetch(`http://127.0.0.1:${ports[0]}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
      });
      expect(created.status).toBe(201);
      const wallet = (await created.json()) as { id: string };

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) => {
          const port = ports[index % ports.length];
          return fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `provider-a:multi-${playerId}-${index}`,
            },
            body: JSON.stringify({
              providerId: 'provider-a',
              externalTransactionId: `multi-${playerId}-${index}`,
              playerId,
              walletId: wallet.id,
              roundId: 'round-987',
              gameId: 'fortune-chimp',
              kind: 'BET',
              money: { amount: '10.00', currency: 'BRL' },
            }),
          });
        }),
      );
      const statuses = await Promise.all(responses.map(async (res) => (await res.json()) as { status?: string }));
      const processed = statuses.filter((item) => item.status === 'PROCESSED').length;
      const rejected = statuses.filter((item) => item.status === 'REJECTED').length;
      expect(processed).toBe(10);
      expect(rejected).toBe(10);

      for (const child of children) child.kill();
      children.length = 0;
      start(ports[0], 'api-restart');
      await waitOk(`http://127.0.0.1:${ports[0]}/health/live`);

      const report = await fetch(`http://127.0.0.1:${ports[0]}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
      const body = (await report.json()) as { consistent: boolean; storedBalance: { amount: string } };
      expect(body.consistent).toBe(true);
      expect(body.storedBalance.amount).toBe('0.00');
    },
    { timeout: 60_000 },
  );
});
