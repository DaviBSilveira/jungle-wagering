import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { DuplicateWalletError, InvalidPayloadError } from '../domain/errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger';
import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/messaging';
import { Wallet } from '../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { LedgerRow, OutboxRow, WagerRow, WalletRow } from '../infrastructure/db/rows';
import { isUniqueViolation } from '../log';
import { sha256, canonicalJson } from './canonical';
import { uuidv7 } from './ids';
import { ProviderIdentity } from './provider-identity';

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

@Injectable()
export class OpenWalletService {
  constructor(
    private readonly orm: MikroORM,
    private readonly identity: ProviderIdentity,
  ) {}

  async open(input: {
    playerId: string;
    initialBalance: { amount: string; currency: string };
    correlationId: string;
  }): Promise<OpenWalletResult> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(input.playerId)) throw new InvalidPayloadError('playerId precisa ser uuid');
    const initial = Money.from(input.initialBalance);
    await this.identity.assertKnown('internal');
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const now = new Date();
        const wallet = Wallet.open({ id: uuidv7(), playerId: input.playerId, initialBalance: initial, now });
        const walletRow = new WalletRow();
        walletRow.id = wallet.id;
        walletRow.playerId = wallet.playerId;
        walletRow.currency = wallet.currency;
        walletRow.balance = wallet.balance.toJSON().amount;
        walletRow.version = wallet.version;
        walletRow.createdAt = wallet.createdAt;
        walletRow.updatedAt = wallet.updatedAt;
        em.persist(walletRow);
        await em.flush();

        if (!initial.isZero()) {
          const externalId = `opening:${wallet.id}`;
          const opening = WagerTransaction.opening({
            id: uuidv7(),
            providerId: 'internal',
            externalTransactionId: externalId,
            idempotencyKey: externalId,
            payloadHash: sha256(canonicalJson({ walletId: wallet.id, amount: initial.toJSON() })),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money: initial,
            createdAt: now,
          });
          const before = Money.zero(initial.currency);
          const entry = WalletLedgerEntry.create({
            id: uuidv7(),
            walletId: wallet.id,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initial,
            balanceBefore: before,
            balanceAfter: initial,
            createdAt: now,
          });
          em.persist(toOpeningRow(opening, initial.toJSON()));
          await em.flush();
          const ledger = new LedgerRow();
          ledger.id = entry.id;
          ledger.walletId = entry.walletId;
          ledger.transactionId = entry.transactionId;
          ledger.direction = entry.direction;
          ledger.amount = entry.money.toJSON().amount;
          ledger.currency = entry.money.currency;
          ledger.balanceBefore = entry.balanceBefore.toJSON().amount;
          ledger.balanceAfter = entry.balanceAfter.toJSON().amount;
          ledger.createdAt = entry.createdAt;
          em.persist(ledger);

          const ctx = { correlationId: input.correlationId, eventId: uuidv7(), occurredAt: now };
          for (const event of [
            WagerTransactionProcessed.from(
              {
                transactionId: opening.id,
                providerId: 'internal',
                externalTransactionId: externalId,
                walletId: wallet.id,
                playerId: wallet.playerId,
                kind: opening.kind,
                status: opening.status,
                money: initial.toJSON(),
              },
              ctx,
            ),
            WalletBalanceChanged.from(wallet, entry, { ...ctx, eventId: uuidv7() }),
          ]) {
            const message = OutboxMessage.enqueue(event);
            const out = new OutboxRow();
            out.id = message.id;
            out.aggregateId = message.aggregateId;
            out.eventType = message.eventType;
            out.payload = message.payload as Record<string, unknown>;
            out.occurredAt = message.occurredAt;
            out.attempts = 0;
            em.persist(out);
          }
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err) || err instanceof UniqueConstraintViolationException) {
        throw new DuplicateWalletError('jogador já tem wallet nessa moeda');
      }
      throw err;
    }
  }
}

function toOpeningRow(tx: WagerTransaction, snapshot: { amount: string; currency: string }): WagerRow {
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
  row.status = WagerTransactionStatus.Processed;
  row.resultBalanceAmount = snapshot.amount;
  row.resultBalanceCurrency = snapshot.currency;
  row.attemptCount = 0;
  row.createdAt = tx.createdAt;
  row.processedAt = tx.processedAt;
  return row;
}
