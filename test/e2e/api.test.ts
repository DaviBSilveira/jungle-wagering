import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { uuidv7 } from '../../src/application/ids';
import { MikroORM } from '@mikro-orm/postgresql';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  process.env.WORKERS_ENABLED = 'false';
  try {
    app = await NestFactory.create(AppModule, { logger: false });
    const orm = app.get(MikroORM);
    await orm.migrator.up();
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 3000;
    base = `http://127.0.0.1:${port}`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'erro';
    throw new Error(`API de teste não subiu. Postgres precisa estar no ar. ${reason}`);
  }
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe('http', () => {
  test('abre wallet, aposta, repete e reconcilia', async () => {
    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);

    const playerId = uuidv7();
    const external = `e2e-bet-${playerId}`;
    const created = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'e2e' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as { id: string; version: number; balance: { amount: string } };
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');

    const body = {
      providerId: 'provider-a',
      externalTransactionId: external,
      playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const headers = {
      'content-type': 'application/json',
      'idempotency-key': `provider-a:${external}`,
    };
    const bet = await fetch(`${base}/wagering/transactions`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(bet.status).toBe(200);
    const first = (await bet.json()) as { balance: { amount: string }; idempotentReplay: boolean; transactionId: string };
    expect(first.balance.amount).toBe('75.00');
    expect(first.idempotentReplay).toBe(false);

    const replay = await fetch(`${base}/wagering/transactions`, { method: 'POST', headers, body: JSON.stringify(body) });
    const second = (await replay.json()) as { idempotentReplay: boolean; transactionId: string };
    expect(replay.status).toBe(200);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    const clash = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, money: { amount: '10.00', currency: 'BRL' } }),
    });
    expect(clash.status).toBe(409);

    const missing = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(missing.status).toBe(400);

    const found = await fetch(`${base}/wagering/transactions/${first.transactionId}`);
    expect(found.status).toBe(200);
    const byExternal = await fetch(`${base}/providers/provider-a/wagering/transactions/${external}`);
    expect(byExternal.status).toBe(200);

    const ledger = await fetch(`${base}/wallets/${wallet.id}/ledger?limit=10`);
    const page = (await ledger.json()) as { items: unknown[] };
    expect(page.items.length).toBeGreaterThan(0);

    const recon = await fetch(`${base}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
    const report = (await recon.json()) as { consistent: boolean };
    expect(report.consistent).toBe(true);

    const dup = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(dup.status).toBe(409);
  });
});
