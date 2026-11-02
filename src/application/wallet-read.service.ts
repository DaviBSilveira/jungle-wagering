import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { InvalidPayloadError, TransactionNotFoundError, WalletNotFoundError } from '../domain/errors';
import { Money } from '../domain/money';
import { WagerRow, WalletRow } from '../infrastructure/db/rows';
import { Metrics } from '../infrastructure/metrics';
import { log } from '../log';
import { decodeCursor, encodeCursor } from './ids';

@Injectable()
export class WalletReadService {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
  ) {}

  async getWallet(id: string) {
    const row = await this.orm.em.fork().findOne(WalletRow, { id });
    if (!row) throw new WalletNotFoundError('wallet não encontrada');
    return {
      id: row.id,
      playerId: row.playerId,
      balance: money(row.balance, row.currency),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async ledger(walletId: string, cursor: string | undefined, limitRaw: string | undefined) {
    await this.getWallet(walletId);
    const limit = parseLimit(limitRaw);
    let cursorDate: Date | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      try {
        const decoded = decodeCursor(cursor);
        cursorDate = decoded.createdAt;
        cursorId = decoded.id;
      } catch {
        throw new InvalidPayloadError('cursor inválido');
      }
    }
    const rows = await this.orm.em.fork().getConnection().execute<
      Array<{
        id: string;
        transaction_id: string;
        direction: string;
        amount: string;
        currency: string;
        balance_before: string;
        balance_after: string;
        created_at: Date | string;
      }>
    >(
      `select id, transaction_id, direction, amount::text, currency, balance_before::text, balance_after::text, created_at
       from wallet_ledger_entries
       where wallet_id = ?
         and (
           ?::timestamptz is null
           or created_at < ?::timestamptz
           or (created_at = ?::timestamptz and id < ?::uuid)
         )
       order by created_at desc, id desc
       limit ?`,
      [walletId, cursorDate, cursorDate, cursorDate, cursorId, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor(new Date(last.created_at), last.id)
        : null;
    return {
      items: page.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: money(row.amount, row.currency.trim()),
        balanceBefore: money(row.balance_before, row.currency.trim()),
        balanceAfter: money(row.balance_after, row.currency.trim()),
        createdAt: new Date(row.created_at).toISOString(),
      })),
      nextCursor,
    };
  }

  async getTransaction(id: string) {
    const row = await this.orm.em.fork().findOne(WagerRow, { id });
    if (!row) throw new TransactionNotFoundError('transação não encontrada');
    return present(row);
  }

  async getByExternal(providerId: string, externalTransactionId: string) {
    const row = await this.orm.em.fork().findOne(WagerRow, { providerId, externalTransactionId });
    if (!row) throw new TransactionNotFoundError('transação não encontrada');
    return present(row);
  }

  async reconcile(walletId: string) {
    const wallet = await this.getWallet(walletId);
    const rows = await this.orm.em.fork().getConnection().execute<Array<{ calc: string; n: string }>>(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as calc,
              count(*)::text as n
       from wallet_ledger_entries
       where wallet_id = ?`,
      [walletId],
    );
    const calculated = Money.fromPersisted(rows[0]?.calc ?? '0', wallet.balance.currency);
    const stored = Money.from(wallet.balance);
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.inc('reconciliation_mismatch_total');
      log('error', 'reconciliação divergente', {
        walletId,
        checkedEntries: Number(rows[0]?.n ?? 0),
      });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: Number(rows[0]?.n ?? 0),
    };
  }
}

function money(amount: string, currency: string) {
  return Money.fromPersisted(String(amount), currency).toJSON();
}

function parseLimit(value: string | undefined): number {
  if (value === undefined || value === '') return 50;
  if (!/^\d+$/.test(value)) throw new InvalidPayloadError('limit inválido');
  const limit = Number(value);
  if (limit < 1 || limit > 100) throw new InvalidPayloadError('limit fora de 1..100');
  return limit;
}

function present(row: WagerRow) {
  return {
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    money: money(String(row.amount), row.currency),
    status: row.status,
    failureCode: row.failureCode ?? null,
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? null,
    createdAt: row.createdAt,
    processedAt: row.processedAt ?? null,
  };
}
