import { beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/domain/errors';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { LedgerRow, OutboxRow, WagerRow, WalletRow } from '../../src/infrastructure/db/rows';
import { PendingReferenceWorker } from '../../src/infrastructure/workers';
import { boot, operation, playerId } from './helpers';

type Ctx = Awaited<ReturnType<typeof boot>>;
let ctx: Ctx;

beforeAll(async () => {
  ctx = await boot();
});

beforeEach(async () => {
  await ctx.reset();
});

afterAll(async () => {
  await ctx?.close();
});

async function open(amount = '100.00') {
  return ctx.wallets.open({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'open',
  });
}

async function balanceOf(id: string) {
  const row = await ctx.orm.em.fork().findOneOrFail(WalletRow, { id });
  return { balance: String(row.balance), version: row.version };
}

async function ledgerCount(walletId: string) {
  return ctx.orm.em.fork().count(LedgerRow, { walletId });
}

describe('aposta no postgres', () => {
  test('bet debita, grava ledger e outbox na mesma tacada', async () => {
    const wallet = await open('100.00');
    const bet = operation({ walletId: wallet.id, amount: '25.00', external: 'bet-1' });
    const result = await ctx.wagers.execute(bet.input, bet.meta);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.idempotentReplay).toBe(false);
    expect(result.balance.amount).toBe('75.00');
    expect((await balanceOf(wallet.id)).version).toBe(2);
    expect(await ledgerCount(wallet.id)).toBe(2);
    expect(await ctx.orm.em.fork().count(OutboxRow, { aggregateId: wallet.id })).toBeGreaterThanOrEqual(2);
    const check = await ctx.reads.reconcile(wallet.id);
    expect(check.consistent).toBe(true);
  });

  test('a mesma chave devolve o saldo da primeira vez, outra payload não', async () => {
    const wallet = await open();
    const bet = operation({ walletId: wallet.id, amount: '25.00', external: 'bet-replay' });
    const first = await ctx.wagers.execute(bet.input, bet.meta);
    const again = await ctx.wagers.execute(bet.input, bet.meta);
    expect(again.idempotentReplay).toBe(true);
    expect(again.transactionId).toBe(first.transactionId);
    expect(again.balance.amount).toBe('75.00');
    const other = operation({ walletId: wallet.id, amount: '10.00', external: 'bet-replay' });
    await expect(ctx.wagers.execute(other.input, { ...bet.meta, payloadHash: other.meta.payloadHash })).rejects.toThrow(
      IdempotencyConflictError,
    );
    expect((await balanceOf(wallet.id)).balance.startsWith('75')).toBe(true);
  });

  test('50 iguais em paralelo geram um débito só', async () => {
    const wallet = await open('100.00');
    const bet = operation({ walletId: wallet.id, amount: '25.00', external: 'bet-50' });
    const results = await Promise.all(Array.from({ length: 50 }, () => ctx.wagers.execute(bet.input, bet.meta)));
    expect(results.filter((item) => !item.idempotentReplay)).toHaveLength(1);
    expect(await ctx.orm.em.fork().count(WagerRow, { idempotencyKey: bet.meta.idempotencyKey })).toBe(1);
    expect(await ledgerCount(wallet.id)).toBe(2);
    expect((await balanceOf(wallet.id)).balance.startsWith('75')).toBe(true);
  });

  test('duas apostas de 80 em saldo 100: uma passa, a outra não, e sobra 20', async () => {
    const wallet = await open('100.00');
    const [a, b] = await Promise.all([
      ctx.wagers.execute(...pair(wallet.id, '80.00', 'a')),
      ctx.wagers.execute(...pair(wallet.id, '80.00', 'b')),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    const rejected = [a, b].find((item) => item.status === WagerTransactionStatus.Rejected);
    expect(rejected?.failureCode).toBe('INSUFFICIENT_BALANCE');
    expect((await balanceOf(wallet.id)).balance.startsWith('20')).toBe(true);
    const debits = await ctx.orm.em.fork().count(LedgerRow, { walletId: wallet.id, direction: 'DEBIT' });
    expect(debits).toBe(1);
    expect((await ctx.reads.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('wallets diferentes não ficam presas uma na outra', async () => {
    const first = await open('50.00');
    const secondPlayer = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2';
    const second = await ctx.wallets.open({
      playerId: secondPlayer,
      initialBalance: { amount: '50.00', currency: 'BRL' },
      correlationId: 'open-2',
    });
    const held = ctx.orm.em.fork();
    await held.begin();
    await held.getConnection().execute(`select id from ${ctx.schema}.wallets where id = ? for update`, [first.id]);
    const started = Date.now();
    const bet = operation({
      walletId: second.id,
      amount: '10.00',
      external: 'outra-wallet',
      player: secondPlayer,
    });
    const result = await ctx.wagers.execute(bet.input, bet.meta);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    await held.rollback();
  });

  test('LOSS não lança, REFUND credita uma vez, ROLLBACK sem saldo é outro código', async () => {
    const wallet = await open('100.00');
    const loss = operation({ walletId: wallet.id, amount: '30.00', external: 'loss-1', kind: WagerTransactionKind.Loss });
    const lossResult = await ctx.wagers.execute(loss.input, loss.meta);
    expect(lossResult.status).toBe(WagerTransactionStatus.Processed);
    expect(await ledgerCount(wallet.id)).toBe(1);

    const bet = operation({ walletId: wallet.id, amount: '40.00', external: 'bet-ref' });
    await ctx.wagers.execute(bet.input, bet.meta);
    const refund = operation({
      walletId: wallet.id,
      amount: '40.00',
      external: 'refund-1',
      kind: WagerTransactionKind.Refund,
      reference: 'bet-ref',
    });
    expect((await ctx.wagers.execute(refund.input, refund.meta)).status).toBe(WagerTransactionStatus.Processed);
    const again = operation({
      walletId: wallet.id,
      amount: '40.00',
      external: 'refund-2',
      kind: WagerTransactionKind.Refund,
      reference: 'bet-ref',
    });
    const second = await ctx.wagers.execute(again.input, again.meta);
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe('ALREADY_REVERSED');

    const win = operation({ walletId: wallet.id, amount: '80.00', external: 'win-1', kind: WagerTransactionKind.Win });
    await ctx.wagers.execute(win.input, win.meta);
    const betMost = operation({ walletId: wallet.id, amount: '150.00', external: 'bet-most' });
    await ctx.wagers.execute(betMost.input, betMost.meta);
    const rollback = operation({
      walletId: wallet.id,
      amount: '80.00',
      external: 'rb-win',
      kind: WagerTransactionKind.Rollback,
      reference: 'win-1',
    });
    const rolled = await ctx.wagers.execute(rollback.input, rollback.meta);
    expect(rolled.failureCode).toBe('NEGATIVE_BALANCE_ON_REVERSAL');
    expect((await ctx.reads.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('refund que chega antes da bet espera e depois aplica', async () => {
    process.env.PENDING_REFERENCE_BASE_DELAY_MS = '0';
    process.env.PENDING_REFERENCE_MAX_ATTEMPTS = '4';
    const wallet = await open('100.00');
    const refund = operation({
      walletId: wallet.id,
      amount: '25.00',
      external: 'refund-cedo',
      kind: WagerTransactionKind.Refund,
      reference: 'bet-tarde',
    });
    const pending = await ctx.wagers.execute(refund.input, refund.meta);
    expect(pending.httpStatus).toBe(202);
    expect(await ledgerCount(wallet.id)).toBe(1);

    const worker = new PendingReferenceWorker(ctx.orm, ctx.wagers);
    await worker.tick();
    const still = await ctx.orm.em.fork().findOneOrFail(WagerRow, { externalTransactionId: 'refund-cedo' });
    expect(still.status).toBe(WagerTransactionStatus.PendingReference);

    const bet = operation({ walletId: wallet.id, amount: '25.00', external: 'bet-tarde' });
    await ctx.wagers.execute(bet.input, bet.meta);
    await worker.tick();
    const done = await ctx.orm.em.fork().findOneOrFail(WagerRow, { externalTransactionId: 'refund-cedo' });
    expect(done.status).toBe(WagerTransactionStatus.Processed);
    expect((await balanceOf(wallet.id)).balance.startsWith('100')).toBe(true);
    expect((await ctx.reads.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('referência que nunca chega vira rejeição', async () => {
    process.env.PENDING_REFERENCE_BASE_DELAY_MS = '0';
    process.env.PENDING_REFERENCE_MAX_ATTEMPTS = '1';
    const wallet = await open('40.00');
    const refund = operation({
      walletId: wallet.id,
      amount: '10.00',
      external: 'refund-orfao',
      kind: WagerTransactionKind.Refund,
      reference: 'nao-existe',
    });
    await ctx.wagers.execute(refund.input, refund.meta);
    await new PendingReferenceWorker(ctx.orm, ctx.wagers).tick();
    const row = await ctx.orm.em.fork().findOneOrFail(WagerRow, { externalTransactionId: 'refund-orfao' });
    expect(row.status).toBe(WagerTransactionStatus.Rejected);
    expect(row.failureCode).toBe('REFERENCE_NOT_FOUND');
    const events = await ctx.orm.em.fork().find(OutboxRow, { aggregateId: wallet.id, eventType: 'WagerTransactionRejected' });
    expect(events.length).toBeGreaterThan(0);
  });

  test('moeda errada rejeita e o ledger não aceita update', async () => {
    const wallet = await open('10.00');
    const usd = operation({ walletId: wallet.id, amount: '1.00', external: 'usd', currency: 'USD' });
    const result = await ctx.wagers.execute(usd.input, usd.meta);
    expect(result.failureCode).toBe('CURRENCY_MISMATCH');
    const connection = ctx.orm.em.fork().getConnection();
    await expect(
      connection.execute(`update ${ctx.schema}.wallet_ledger_entries set amount = 1`),
    ).rejects.toThrow();
    await expect(
      connection.execute(`update ${ctx.schema}.wallets set balance = -1 where id = ?`, [wallet.id]),
    ).rejects.toThrow();
    await expect(
      connection.execute(`update ${ctx.schema}.wallets set balance = 1 where id = ?`, [wallet.id]),
    ).rejects.toThrow();
    expect((await ctx.reads.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('wallet duplicada é conflito', async () => {
    await open('1.00');
    await expect(open('1.00')).rejects.toThrow(/wallet/);
  });
});

function pair(walletId: string, amount: string, external: string) {
  const op = operation({ walletId, amount, external });
  return [op.input, op.meta] as const;
}
