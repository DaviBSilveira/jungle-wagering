import { LockMode, UniqueConstraintViolationException, type EntityManager } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { env } from '../config';
import { decideWager, type ReferenceView } from '../domain/decide-wager';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
  type FailureCode,
} from '../domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEvent,
} from '../domain/events';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger';
import { Money } from '../domain/money';
import { InboxMessage, OutboxMessage } from '../domain/messaging';
import { Wallet } from '../domain/wallet';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { InboxRow, LedgerRow, OutboxRow, WagerRow, WalletRow } from '../infrastructure/db/rows';
import { Metrics } from '../infrastructure/metrics';
import { errorFields, isUniqueViolation, log, sqlState } from '../log';
import { uuidv7 } from './ids';
import { ProviderIdentity } from './provider-identity';
import type { ProcessMeta, WagerInput } from './wager-input';

export const WAGER_CONSUMER = 'wager-transactions';

export interface WagerResult {
  httpStatus: 200 | 202 | 422;
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerService {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
    private readonly identity: ProviderIdentity,
  ) {}

  async execute(input: WagerInput, meta: ProcessMeta): Promise<WagerResult> {
    await this.identity.assertKnown(input.providerId);
    const started = Date.now();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await this.orm.em.fork().transactional(async (em) => this.inTx(em, input, meta));
          this.observe(result, input, meta, started);
          return result;
        } catch (err) {
          if (sqlState(err) === '40P01' && attempt < 2) {
            this.metrics.inc('lock_conflicts_total');
            continue;
          }
          if (isUniqueViolation(err) || err instanceof UniqueConstraintViolationException) {
            const resolved = await this.afterUnique(input, meta);
            this.observe(resolved, input, meta, started);
            return resolved;
          }
          throw err;
        }
      }
      throw new Error('deadlock na wallet');
    } catch (err) {
      if (!(err instanceof IdempotencyConflictError)) {
        log('error', 'falha ao processar wager', {
          ...errorFields(err),
          correlationId: meta.correlationId,
          messageId: meta.messageId,
          walletId: input.walletId,
          providerId: input.providerId,
        });
      }
      throw err;
    }
  }

  async reprocessPending(id: string): Promise<void> {
    const settings = env();
    await this.orm.em.fork().transactional(async (em) => this.reprocessInTx(em, id, settings));
  }

  private async reprocessInTx(
    em: EntityManager,
    id: string,
    settings: ReturnType<typeof env>,
  ): Promise<void> {
    const peek = await em.findOne(WagerRow, { id });
    if (!peek || peek.status !== WagerTransactionStatus.PendingReference) return;

    const walletRow = await em.findOne(WalletRow, { id: peek.walletId }, { lockMode: pessimistic() });
    if (!walletRow) return;
    const row = await em.findOne(WagerRow, { id }, { lockMode: pessimistic() });
    if (!row || row.status !== WagerTransactionStatus.PendingReference) return;

    const wallet = toWallet(walletRow);
    const input = inputFromRow(row);
    const reference = await this.loadReference(em, input);
    const alreadyReversed = await this.hasReversal(em, input);
    const decision = decideWager(
      {
        kind: input.kind,
        money: Money.from(input.money),
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        providerId: input.providerId,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      },
      { playerId: wallet.playerId, currency: wallet.currency, balance: wallet.balance },
      reference,
      alreadyReversed,
    );

    const tx = rehydrateTx(row);
    const now = new Date();
    const correlationId = `pending:${row.id}`;

    if (decision.outcome === 'pending_reference') {
      row.attemptCount += 1;
      if (row.attemptCount >= settings.pendingMaxAttempts) {
        tx.reject(FailureCodeReferenceNotFound());
        this.applyTx(row, tx, wallet.balance.toJSON());
        this.persistEvents(em, eventsFor(tx, wallet, input, { correlationId, eventId: uuidv7(), occurredAt: now }));
        return;
      }
      const exp = Math.min(row.attemptCount, 6);
      const delay = Math.min(settings.pendingBaseDelayMs * 2 ** exp, 60_000);
      row.nextAttemptAt = new Date(now.getTime() + delay);
      this.metrics.inc('messaging_retries_total', { source: 'pending_reference' });
      return;
    }

    if (decision.outcome === 'rejected') {
      tx.reject(decision.code);
      this.applyTx(row, tx, wallet.balance.toJSON());
      this.persistEvents(em, eventsFor(tx, wallet, input, { correlationId, eventId: uuidv7(), occurredAt: now }));
      return;
    }

    const entry = this.applyMovement(tx, wallet, decision.direction, reference?.id, now);
    if (entry) {
      em.persist(toLedgerRow(entry));
      copyWallet(walletRow, wallet);
    }
    this.applyTx(row, tx, wallet.balance.toJSON());
    const ctx = { correlationId, eventId: uuidv7(), occurredAt: now };
    const events = eventsFor(tx, wallet, input, ctx);
    if (entry) events.push(WalletBalanceChanged.from(wallet, entry, { ...ctx, eventId: uuidv7() }));
    this.persistEvents(em, events);
  }

  private async inTx(em: EntityManager, input: WagerInput, meta: ProcessMeta): Promise<WagerResult> {
    if (meta.messageId) {
      const inbox = await em.findOne(
        InboxRow,
        { consumerName: WAGER_CONSUMER, messageId: meta.messageId },
        { lockMode: pessimistic() },
      );
      if (inbox) {
        if (inbox.payloadHash !== meta.payloadHash) {
          throw new IdempotencyConflictError('messageId reutilizada com outro payload');
        }
        const existing = await this.findExisting(em, input, meta);
        if (!existing) throw new Error('inbox sem transação');
        return this.replay(existing);
      }
    }

    const existing = await this.findExisting(em, input, meta);
    if (existing) return this.finishReplay(em, existing, meta);

    // Wallet primeiro, referência depois. Outra ordem dá deadlock entre instâncias.
    const walletRow = await em.findOne(WalletRow, { id: input.walletId }, { lockMode: pessimistic() });
    if (!walletRow) throw new WalletNotFoundError('wallet não encontrada');

    const again = await this.findExisting(em, input, meta);
    if (again) return this.finishReplay(em, again, meta);

    const wallet = toWallet(walletRow);
    const money = Money.from(input.money);
    const reference = await this.loadReference(em, input);
    const alreadyReversed = await this.hasReversal(em, input);
    const decision = decideWager(
      { ...input, money },
      { playerId: wallet.playerId, currency: wallet.currency, balance: wallet.balance },
      reference,
      alreadyReversed,
    );

    const now = new Date();
    const tx = WagerTransaction.create({
      id: uuidv7(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: meta.idempotencyKey,
      payloadHash: meta.payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });

    const settings = env();
    let entry: WalletLedgerEntry | undefined;
    if (decision.outcome === 'pending_reference') {
      tx.markPendingReference();
    } else if (decision.outcome === 'rejected') {
      tx.reject(decision.code);
    } else {
      entry = this.applyMovement(tx, wallet, decision.direction, reference?.id, now);
    }

    const snapshot = wallet.balance.toJSON();
    const row = toWagerRow(tx, snapshot);
    if (decision.outcome === 'pending_reference') {
      row.attemptCount = 0;
      row.nextAttemptAt = new Date(now.getTime() + settings.pendingBaseDelayMs);
    }
    em.persist(row);
    await em.flush();
    if (entry) {
      copyWallet(walletRow, wallet);
      em.persist(toLedgerRow(entry));
      await em.flush();
    }
    const ctx: EventContext = {
      correlationId: meta.correlationId,
      causationId: meta.causationId ?? meta.messageId,
      eventId: uuidv7(),
      occurredAt: now,
    };
    const events = eventsFor(tx, wallet, input, ctx);
    if (entry) events.push(WalletBalanceChanged.from(wallet, entry, { ...ctx, eventId: uuidv7() }));
    this.persistEvents(em, events);
    this.attachInbox(em, meta, now);
    return toResult(tx, snapshot, false);
  }

  private applyMovement(
    tx: WagerTransaction,
    wallet: Wallet,
    direction: LedgerDirection | null,
    referenceId: string | undefined,
    now: Date,
  ): WalletLedgerEntry | undefined {
    if (!direction) {
      tx.markProcessed(referenceId, now);
      return undefined;
    }
    const before = wallet.balance;
    if (direction === LedgerDirection.Debit) wallet.debit(tx.money);
    else wallet.credit(tx.money);
    tx.markProcessed(referenceId, now);
    return WalletLedgerEntry.create({
      id: uuidv7(),
      walletId: wallet.id,
      transactionId: tx.id,
      direction,
      money: tx.money,
      balanceBefore: before,
      balanceAfter: wallet.balance,
      createdAt: now,
    });
  }

  private async finishReplay(em: EntityManager, row: WagerRow, meta: ProcessMeta): Promise<WagerResult> {
    if (row.payloadHash !== meta.payloadHash) {
      throw new IdempotencyConflictError('mesma chave com payload diferente');
    }
    this.attachInbox(em, meta, new Date());
    return this.replay(row);
  }

  private attachInbox(em: EntityManager, meta: ProcessMeta, at = new Date()): void {
    if (!meta.messageId) return;
    const inbox = InboxMessage.receive({
      messageId: meta.messageId,
      consumerName: WAGER_CONSUMER,
      payloadHash: meta.payloadHash,
      receivedAt: at,
    });
    inbox.markProcessed(at);
    const row = new InboxRow();
    row.consumerName = inbox.consumerName;
    row.messageId = inbox.messageId;
    row.payloadHash = inbox.payloadHash;
    row.receivedAt = inbox.receivedAt;
    row.processedAt = inbox.processedAt;
    em.persist(row);
  }

  private persistEvents(em: EntityManager, events: IntegrationEvent<unknown>[]): void {
    for (const event of events) {
      const message = OutboxMessage.enqueue(event);
      const row = new OutboxRow();
      row.id = message.id;
      row.aggregateId = message.aggregateId;
      row.eventType = message.eventType;
      row.payload = message.payload as Record<string, unknown>;
      row.occurredAt = message.occurredAt;
      row.attempts = message.attempts;
      row.nextAttemptAt = message.nextAttemptAt;
      row.publishedAt = message.publishedAt;
      em.persist(row);
    }
  }

  private async findExisting(em: EntityManager, input: WagerInput, meta: ProcessMeta): Promise<WagerRow | null> {
    const byKey = await em.findOne(WagerRow, { idempotencyKey: meta.idempotencyKey });
    if (byKey) return byKey;
    return em.findOne(WagerRow, {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
    });
  }

  private async loadReference(em: EntityManager, input: WagerInput): Promise<ReferenceView | null> {
    if (!input.referenceExternalTransactionId) return null;
    const row = await em.findOne(
      WagerRow,
      { providerId: input.providerId, externalTransactionId: input.referenceExternalTransactionId },
      { lockMode: pessimistic() },
    );
    if (!row) return null;
    return {
      id: row.id,
      providerId: row.providerId,
      playerId: row.playerId,
      walletId: row.walletId,
      roundId: row.roundId,
      currency: row.currency.trim(),
      kind: row.kind,
      status: row.status,
      money: Money.fromPersisted(String(row.amount), row.currency),
    };
  }

  private async hasReversal(em: EntityManager, input: WagerInput): Promise<boolean> {
    if (!input.referenceExternalTransactionId) return false;
    if (input.kind !== WagerTransactionKind.Refund && input.kind !== WagerTransactionKind.Rollback) return false;
    const found = await em.findOne(WagerRow, {
      providerId: input.providerId,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return Boolean(found);
  }

  private async afterUnique(input: WagerInput, meta: ProcessMeta): Promise<WagerResult> {
    const em = this.orm.em.fork();
    const existing = await this.findExisting(em, input, meta);
    if (existing) {
      if (existing.payloadHash !== meta.payloadHash) {
        this.metrics.inc('wager_transactions_total', { status: 'CONFLICT', source: meta.source });
        throw new IdempotencyConflictError('mesma chave com payload diferente');
      }
      return this.replay(existing);
    }
    return this.persistAlreadyReversed(input, meta);
  }

  private async persistAlreadyReversed(input: WagerInput, meta: ProcessMeta): Promise<WagerResult> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const walletRow = await em.findOne(WalletRow, { id: input.walletId }, { lockMode: pessimistic() });
        if (!walletRow) throw new WalletNotFoundError('wallet não encontrada');
        const again = await this.findExisting(em, input, meta);
        if (again) return this.finishReplay(em, again, meta);
        const wallet = toWallet(walletRow);
        const tx = WagerTransaction.create({
          id: uuidv7(),
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: meta.idempotencyKey,
          payloadHash: meta.payloadHash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money: Money.from(input.money),
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          createdAt: new Date(),
        });
        tx.reject(codeAlreadyReversed());
        const snapshot = wallet.balance.toJSON();
        em.persist(toWagerRow(tx, snapshot));
        this.persistEvents(
          em,
          eventsFor(tx, wallet, input, {
            correlationId: meta.correlationId,
            causationId: meta.causationId,
            eventId: uuidv7(),
          }),
        );
        this.attachInbox(em, meta);
        return toResult(tx, snapshot, false);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await this.findExisting(this.orm.em.fork(), input, meta);
        if (existing) return this.replay(existing);
      }
      throw err;
    }
  }

  private replay(row: WagerRow): WagerResult {
    const currency = row.resultBalanceCurrency ?? row.currency;
    const amount = Money.fromPersisted(String(row.resultBalanceAmount ?? row.amount), currency).toJSON().amount;
    return {
      httpStatus: httpStatusFor(row.status),
      transactionId: row.id,
      status: row.status,
      balance: { amount, currency },
      failureCode: row.failureCode ?? undefined,
      idempotentReplay: true,
    };
  }

  private applyTx(row: WagerRow, tx: WagerTransaction, snapshot: { amount: string; currency: string }): void {
    row.status = tx.status;
    row.failureCode = tx.failureCode;
    row.processedAt = tx.processedAt;
    row.referenceTransactionId = tx.referenceTransactionId;
    row.resultBalanceAmount = snapshot.amount;
    row.resultBalanceCurrency = snapshot.currency;
    if (tx.status !== WagerTransactionStatus.PendingReference) row.nextAttemptAt = undefined;
  }

  private observe(result: WagerResult, input: WagerInput, meta: ProcessMeta, started: number): void {
    this.metrics.inc('wager_transactions_total', { status: result.status, source: meta.source });
    if (result.idempotentReplay) this.metrics.inc('wager_duplicates_total', { source: meta.source });
    this.metrics.observe('wager_processing_seconds', { source: meta.source }, (Date.now() - started) / 1000);
    log('info', 'wager decidida', {
      correlationId: meta.correlationId,
      messageId: meta.messageId,
      transactionId: result.transactionId,
      walletId: input.walletId,
      providerId: input.providerId,
      status: result.status,
      failureCode: result.failureCode,
      replay: result.idempotentReplay,
      source: meta.source,
    });
  }
}

function FailureCodeReferenceNotFound(): FailureCode {
  return 'REFERENCE_NOT_FOUND';
}

function codeAlreadyReversed(): FailureCode {
  return 'ALREADY_REVERSED';
}

function pessimistic(): LockMode {
  return LockMode.PESSIMISTIC_WRITE;
}

function httpStatusFor(status: WagerTransactionStatus): 200 | 202 | 422 {
  if (status === WagerTransactionStatus.Processed) return 200;
  if (status === WagerTransactionStatus.Pending || status === WagerTransactionStatus.PendingReference) return 202;
  return 422;
}

function toResult(
  tx: WagerTransaction,
  snapshot: { amount: string; currency: string },
  idempotentReplay: boolean,
): WagerResult {
  return {
    httpStatus: httpStatusFor(tx.status),
    transactionId: tx.id,
    status: tx.status,
    balance: snapshot,
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}

function eventsFor(
  tx: WagerTransaction,
  wallet: Wallet,
  input: WagerInput,
  ctx: EventContext,
): IntegrationEvent<unknown>[] {
  const data = {
    transactionId: tx.id,
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    walletId: wallet.id,
    playerId: input.playerId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    failureCode: tx.failureCode,
  };
  if (tx.status === WagerTransactionStatus.Processed) return [WagerTransactionProcessed.from(data, ctx)];
  if (tx.status === WagerTransactionStatus.Rejected || tx.status === WagerTransactionStatus.Failed) {
    return [WagerTransactionRejected.from(data, ctx)];
  }
  return [WagerTransactionPendingReference.from(data, ctx)];
}

function copyWallet(row: WalletRow, wallet: Wallet): void {
  row.balance = wallet.balance.toJSON().amount;
  row.version = wallet.version;
  row.updatedAt = wallet.updatedAt;
}

function toWallet(row: WalletRow): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency.trim(),
      balance: Money.fromPersisted(String(row.balance), row.currency.trim()),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function inputFromRow(row: WagerRow): WagerInput {
  return {
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    playerId: row.playerId,
    walletId: row.walletId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    money: { amount: Money.fromPersisted(String(row.amount), row.currency).toJSON().amount, currency: row.currency },
    referenceExternalTransactionId: row.referenceExternalTransactionId,
  };
}

function rehydrateTx(row: WagerRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    money: Money.fromPersisted(String(row.amount), row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId,
    createdAt: row.createdAt,
    status: row.status,
    referenceTransactionId: row.referenceTransactionId,
    failureCode: row.failureCode,
    processedAt: row.processedAt,
  });
}

function toWagerRow(tx: WagerTransaction, snapshot: { amount: string; currency: string }): WagerRow {
  const row = new WagerRow();
  row.id = tx.id;
  row.providerId = tx.providerId;
  row.externalTransactionId = tx.externalTransactionId;
  row.idempotencyKey = tx.idempotencyKey;
  row.payloadHash = tx.payloadHash;
  row.walletId = tx.walletId;
  row.playerId = tx.playerId;
  row.roundId = tx.roundId;
  row.gameId = tx.gameId;
  row.kind = tx.kind;
  row.amount = tx.money.toJSON().amount;
  row.currency = tx.money.currency;
  row.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  row.status = tx.status;
  row.referenceTransactionId = tx.referenceTransactionId;
  row.failureCode = tx.failureCode;
  row.resultBalanceAmount = snapshot.amount;
  row.resultBalanceCurrency = snapshot.currency;
  row.attemptCount = 0;
  row.createdAt = tx.createdAt;
  row.processedAt = tx.processedAt;
  return row;
}

function toLedgerRow(entry: WalletLedgerEntry): LedgerRow {
  const row = new LedgerRow();
  row.id = entry.id;
  row.walletId = entry.walletId;
  row.transactionId = entry.transactionId;
  row.direction = entry.direction;
  row.amount = entry.money.toJSON().amount;
  row.currency = entry.money.currency;
  row.balanceBefore = entry.balanceBefore.toJSON().amount;
  row.balanceAfter = entry.balanceAfter.toJSON().amount;
  row.createdAt = entry.createdAt;
  return row;
}
