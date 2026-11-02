import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { wagerPayloadHash } from '../../src/application/canonical';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { InboxRow, OutboxRow, WalletRow } from '../../src/infrastructure/db/rows';
import { SqsGateway } from '../../src/infrastructure/sqs';
import { DomainEventConsumer, OutboxPublisher, WagerConsumer } from '../../src/infrastructure/workers';
import { env } from '../../src/config';
import { boot, operation, playerId } from './helpers';

const queueSuffix = Math.random().toString(36).slice(2, 8);
process.env.SQS_WAGER_QUEUE = `wager-it-${queueSuffix}.fifo`;
process.env.SQS_WAGER_DLQ = `wager-it-dlq-${queueSuffix}.fifo`;
process.env.SQS_EVENTS_QUEUE = `events-it-${queueSuffix}.fifo`;
process.env.SQS_EVENTS_DLQ = `events-it-dlq-${queueSuffix}.fifo`;

const ctxPromise = boot();
let ctx: Awaited<ReturnType<typeof boot>>;
let sqs: SqsGateway;

beforeAll(async () => {
  ctx = await ctxPromise;
  sqs = new SqsGateway();
  const up = await sqs.probe();
  if (!up) throw new Error('LocalStack não respondeu em SQS_ENDPOINT. Sobe com docker compose up -d localstack.');
});

beforeEach(async () => {
  await ctx.reset();
});

afterAll(async () => {
  await ctx?.close();
});

function envelope(walletId: string, external: string, amount = '10.00') {
  return JSON.stringify({
    messageId: `msg-${external}`,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: external,
      idempotencyKey: `provider-a:${external}`,
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount, currency: 'BRL' },
    },
  });
}

describe('fila', () => {
  test('redelivery depois do commit não debita de novo', async () => {
    const wallet = await ctx.wallets.open({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'sqs',
    });
    const body = envelope(wallet.id, 'sqs-bet');
    const nonce = `${Date.now().toString(36)}-${wallet.id.slice(-6)}`;
    await sqs.send(env().wagerQueue, body, wallet.id, `${nonce}-1`);
    const consumer = new WagerConsumer(sqs, ctx.wagers, ctx.metrics);
    await consumer.tick();
    const afterFirst = await ctx.orm.em.fork().findOneOrFail(WalletRow, { id: wallet.id });
    await sqs.send(env().wagerQueue, body, wallet.id, `${nonce}-2`);
    await consumer.tick();
    const afterSecond = await ctx.orm.em.fork().findOneOrFail(WalletRow, { id: wallet.id });
    expect(String(afterFirst.balance)).toBe(String(afterSecond.balance));
    expect(String(afterSecond.balance).startsWith('90')).toBe(true);
    const inbox = await ctx.orm.em.fork().find(InboxRow, { consumerName: 'wager-transactions' });
    expect(inbox).toHaveLength(1);
  });

  test('payload lixo vai para a DLQ', async () => {
    await sqs.send(env().wagerQueue, '{', 'dlq', `bad-${Date.now()}`);
    const consumer = new WagerConsumer(sqs, ctx.wagers, ctx.metrics);
    await consumer.tick();
    const dead = await sqs.receive(env().wagerDlq);
    expect(dead.length).toBeGreaterThan(0);
    for (const message of dead) {
      if (message.ReceiptHandle) await sqs.remove(env().wagerDlq, message.ReceiptHandle);
    }
  });

  test('dois publishers e uma publicação repetida não aplicam o evento duas vezes', async () => {
    const wallet = await ctx.wallets.open({
      playerId,
      initialBalance: { amount: '30.00', currency: 'BRL' },
      correlationId: 'outbox',
    });
    const bet = operation({ walletId: wallet.id, amount: '5.00', external: 'outbox-bet' });
    await ctx.wagers.execute(bet.input, bet.meta);
    const publisher = new OutboxPublisher(ctx.orm, sqs, ctx.metrics);
    await Promise.all([publisher.tick(), publisher.tick()]);
    const pending = await ctx.orm.em.fork().count(OutboxRow, { publishedAt: null });
    expect(pending).toBe(0);

    const events = await ctx.orm.em.fork().find(OutboxRow, { eventType: 'WalletBalanceChanged' });
    expect(events.length).toBeGreaterThan(0);
    const payload = events[0].payload;
    await sqs.send(env().eventsQueue, JSON.stringify(payload), wallet.id, `dup-${Date.now()}-1`);
    await sqs.send(env().eventsQueue, JSON.stringify(payload), wallet.id, `dup-${Date.now()}-2`);
    const eventsConsumer = new DomainEventConsumer(ctx.orm, sqs, ctx.metrics);
    await eventsConsumer.tick();
    await eventsConsumer.tick();
    const eventId = String(payload.eventId);
    const seen = await ctx.orm.em.fork().count(InboxRow, { consumerName: 'domain-events', messageId: eventId });
    expect(seen).toBe(1);
    const fresh = await ctx.orm.em.fork().findOneOrFail(WalletRow, { id: wallet.id });
    expect(String(fresh.balance).startsWith('25')).toBe(true);
    expect(wagerPayloadHash(bet.input)).toHaveLength(64);
  });
});
