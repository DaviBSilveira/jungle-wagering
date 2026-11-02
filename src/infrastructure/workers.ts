import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Message } from '@aws-sdk/client-sqs';
import { env } from '../config';
import { sha256 } from '../application/canonical';
import { uuidv7 } from '../application/ids';
import { ProcessWagerService } from '../application/process-wager.service';
import { wagerPayloadHash } from '../application/canonical';
import { parseSqsEnvelope } from '../application/wager-input';
import { IdempotencyConflictError, InvalidPayloadError, WalletNotFoundError } from '../domain/errors';
import { OutboxMessage } from '../domain/messaging';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { errorFields, isTransientError, isUniqueViolation, log } from '../log';
import { InboxRow, OutboxRow, WagerRow } from './db/rows';
import { Metrics } from './metrics';
import { SqsGateway } from './sqs';

const DOMAIN_CONSUMER = 'domain-events';

@Injectable()
export class OutboxPublisher {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.current = this.tick().catch((err) => log('error', 'outbox tick', errorFields(err)));
    }, env().outboxPollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.current) await this.current;
  }

  async tick(): Promise<number> {
    const claimed = await this.claim();
    for (const item of claimed) {
      if (this.stopped) {
        await this.release(item.id, item.token);
        continue;
      }
      try {
        const eventId = typeof item.payload.eventId === 'string' ? item.payload.eventId : item.id;
        await this.sqs.send(env().eventsQueue, JSON.stringify(item.payload), item.aggregateId || 'wallet', eventId);
        await this.markPublished(item.id, item.token);
      } catch (err) {
        this.metrics.inc('messaging_retries_total', { source: 'outbox' });
        await this.release(item.id, item.token);
        log('warn', 'publicação da outbox falhou', { ...errorFields(err), transactionId: item.id });
      }
    }
    return claimed.length;
  }

  private async claim(): Promise<Array<{ id: string; token: string; aggregateId: string; payload: Record<string, unknown> }>> {
    const token = uuidv7();
    const expires = new Date(Date.now() + 30_000);
    return this.orm.em.fork().transactional(async (em) => {
      const rows = await em.find(
        OutboxRow,
        {
          publishedAt: null,
          $and: [
            { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }] },
            { $or: [{ claimExpiresAt: null }, { claimExpiresAt: { $lte: new Date() } }] },
          ],
        },
        {
          limit: 20,
          orderBy: { occurredAt: 'asc' },
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        },
      );
      return rows.map((row) => {
        row.claimToken = token;
        row.claimExpiresAt = expires;
        return {
          id: row.id,
          token,
          aggregateId: row.aggregateId,
          payload: JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>,
        };
      });
    });
  }

  private async markPublished(id: string, token: string): Promise<void> {
    await this.orm.em.fork().nativeUpdate(
      OutboxRow,
      { id, claimToken: token },
      { publishedAt: new Date(), claimToken: null, claimExpiresAt: null },
    );
  }

  private async release(id: string, token: string): Promise<void> {
    await this.orm.em.fork().transactional(async (em) => {
      const row = await em.findOne(OutboxRow, { id, claimToken: token });
      if (!row || row.publishedAt) return;
      const message = OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
        payload: row.payload,
        occurredAt: row.occurredAt,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        publishedAt: row.publishedAt,
      });
      message.scheduleRetry(new Date(), env().outboxRetryBaseMs);
      row.attempts = message.attempts;
      row.nextAttemptAt = message.nextAttemptAt;
      row.claimToken = null;
      row.claimExpiresAt = null;
    });
  }
}

@Injectable()
export class WagerConsumer {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;

  constructor(
    private readonly sqs: SqsGateway,
    private readonly wagers: ProcessWagerService,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.current = this.tick().catch((err) => log('error', 'consumer tick', errorFields(err)));
    }, env().consumerPollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.current) await this.current;
  }

  async tick(): Promise<void> {
    const queue = env().wagerQueue;
    const messages = await this.sqs.receive(queue);
    for (const message of messages) {
      if (this.stopped) {
        if (message.ReceiptHandle) await this.sqs.changeVisibility(queue, message.ReceiptHandle, 0);
        continue;
      }
      await this.handle(message);
    }
  }

  private async handle(message: Message): Promise<void> {
    const queue = env().wagerQueue;
    const receipt = message.ReceiptHandle;
    if (!receipt || !message.Body) {
      await this.deadLetter(message);
      return;
    }
    try {
      const parsed = parseSqsEnvelope(message.Body);
      const result = await this.wagers.execute(parsed.input, {
        idempotencyKey: parsed.idempotencyKey,
        correlationId: parsed.messageId,
        causationId: parsed.messageId,
        source: 'sqs',
        messageId: parsed.messageId,
        payloadHash: wagerPayloadHash(parsed.input),
      });
      log('info', 'mensagem de aposta commitada', {
        correlationId: parsed.messageId,
        messageId: parsed.messageId,
        transactionId: result.transactionId,
        walletId: parsed.input.walletId,
        providerId: parsed.input.providerId,
        status: result.status,
      });
      await this.sqs.remove(queue, receipt);
    } catch (err) {
      const receives = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      if (err instanceof InvalidPayloadError || err instanceof IdempotencyConflictError) {
        await this.deadLetter(message);
        return;
      }
      if ((err instanceof WalletNotFoundError || isTransientError(err)) && receives < 5) {
        this.metrics.inc('messaging_retries_total', { source: 'wager' });
        const delay = Math.min(2 ** receives, 30);
        await this.sqs.changeVisibility(queue, receipt, delay);
        return;
      }
      await this.deadLetter(message);
    }
  }

  private async deadLetter(message: Message): Promise<void> {
    const body = message.Body ?? '{}';
    const dedup = `${message.MessageId ?? uuidv7()}:dlq`;
    await this.sqs.send(env().wagerDlq, body, 'dlq', dedup);
    if (message.ReceiptHandle) await this.sqs.remove(env().wagerQueue, message.ReceiptHandle);
    this.metrics.inc('sqs_dlq_messages_total', { queue: 'wager' });
  }
}

@Injectable()
export class DomainEventConsumer {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.current = this.tick().catch((err) => log('error', 'evento tick', errorFields(err)));
    }, env().consumerPollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.current) await this.current;
  }

  async tick(): Promise<void> {
    const messages = await this.sqs.receive(env().eventsQueue);
    for (const message of messages) {
      if (!message.Body || !message.ReceiptHandle) continue;
      try {
        const body = JSON.parse(message.Body) as { eventId?: string };
        if (!body.eventId) throw new InvalidPayloadError('evento sem eventId');
        const hash = sha256(message.Body);
        await this.orm.em.fork().transactional(async (em) => {
          const existing = await em.findOne(InboxRow, { consumerName: DOMAIN_CONSUMER, messageId: body.eventId });
          if (existing) {
            if (existing.payloadHash !== hash) throw new IdempotencyConflictError('evento repetido com outro corpo');
            this.metrics.inc('wager_duplicates_total', { source: 'domain-event' });
            return;
          }
          const row = new InboxRow();
          row.consumerName = DOMAIN_CONSUMER;
          row.messageId = body.eventId!;
          row.payloadHash = hash;
          row.receivedAt = new Date();
          row.processedAt = new Date();
          em.persist(row);
        });
        await this.sqs.remove(env().eventsQueue, message.ReceiptHandle);
      } catch (err) {
        if (isUniqueViolation(err)) {
          await this.sqs.remove(env().eventsQueue, message.ReceiptHandle);
          continue;
        }
        if (err instanceof InvalidPayloadError || err instanceof IdempotencyConflictError) {
          await this.sqs.send(env().eventsDlq, message.Body, 'dlq', `${message.MessageId ?? uuidv7()}:dlq`);
          await this.sqs.remove(env().eventsQueue, message.ReceiptHandle);
          this.metrics.inc('sqs_dlq_messages_total', { queue: 'events' });
          continue;
        }
        this.metrics.inc('messaging_retries_total', { source: 'domain-event' });
        await this.sqs.changeVisibility(env().eventsQueue, message.ReceiptHandle, 2);
      }
    }
  }
}

@Injectable()
export class PendingReferenceWorker {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;

  constructor(
    private readonly orm: MikroORM,
    private readonly wagers: ProcessWagerService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.current = this.tick().catch((err) => log('error', 'pending tick', errorFields(err)));
    }, env().pendingPollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.current) await this.current;
  }

  async tick(): Promise<void> {
    const rows = await this.orm.em.fork().find(
      WagerRow,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
      },
      { limit: 20, orderBy: { nextAttemptAt: 'asc' } },
    );
    for (const row of rows) {
      if (this.stopped) return;
      await this.wagers.reprocessPending(row.id);
    }
  }
}

@Injectable()
export class WorkerRuntime implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly publisher: OutboxPublisher,
    private readonly wagers: WagerConsumer,
    private readonly events: DomainEventConsumer,
    private readonly pending: PendingReferenceWorker,
  ) {}

  onModuleInit(): void {
    if (!env().workersEnabled) return;
    this.publisher.start();
    this.wagers.start();
    this.events.start();
    this.pending.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.wagers.stop();
    await this.pending.stop();
    await this.publisher.stop();
    await this.events.stop();
  }
}
