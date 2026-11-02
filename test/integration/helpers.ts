import { MikroORM } from '@mikro-orm/postgresql';
import { wagerPayloadHash } from '../../src/application/canonical';
import { OpenWalletService } from '../../src/application/open-wallet.service';
import { ProcessWagerService } from '../../src/application/process-wager.service';
import { ProviderIdentity } from '../../src/application/provider-identity';
import { WalletReadService } from '../../src/application/wallet-read.service';
import type { ProcessMeta, WagerInput } from '../../src/application/wager-input';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { ormConfig } from '../../src/infrastructure/db/orm';
import { Metrics } from '../../src/infrastructure/metrics';

export const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

export async function boot() {
  const schema = `it_${Math.random().toString(36).slice(2, 10)}`;
  let orm: MikroORM;
  try {
    const admin = await MikroORM.init(ormConfig());
    await admin.em.getConnection().execute(`create schema if not exists ${schema}`);
    await admin.close(true);
    orm = await MikroORM.init(ormConfig({ schema }));
    await orm.migrator.up();
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'erro';
    throw new Error(`Postgres não respondeu em ${process.env.DATABASE_URL ?? 'localhost:5432'}. Sobe com docker compose up -d postgres. ${reason}`);
  }

  const metrics = new Metrics();
  const identity = new ProviderIdentity();
  return {
    orm,
    schema,
    metrics,
    wallets: new OpenWalletService(orm, identity),
    wagers: new ProcessWagerService(orm, metrics, identity),
    reads: new WalletReadService(orm, metrics),
    async reset() {
      await orm.em.fork().getConnection().execute(
        `truncate table ${schema}.inbox_messages, ${schema}.outbox_messages, ${schema}.wallet_ledger_entries, ${schema}.wager_transactions, ${schema}.wallets cascade`,
      );
    },
    async close() {
      await orm.close(true);
      const admin = await MikroORM.init(ormConfig());
      await admin.em.getConnection().execute(`drop schema if exists ${schema} cascade`);
      await admin.close(true);
    },
  };
}

export function operation(props: {
  walletId: string;
  amount: string;
  external: string;
  kind?: WagerTransactionKind;
  reference?: string;
  player?: string;
  currency?: string;
}): { input: WagerInput; meta: ProcessMeta } {
  const input: WagerInput = {
    providerId: 'provider-a',
    externalTransactionId: props.external,
    playerId: props.player ?? playerId,
    walletId: props.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: props.kind ?? WagerTransactionKind.Bet,
    money: { amount: props.amount, currency: props.currency ?? 'BRL' },
    referenceExternalTransactionId: props.reference,
  };
  return {
    input,
    meta: {
      idempotencyKey: `provider-a:${props.external}`,
      correlationId: props.external,
      source: 'http',
      payloadHash: wagerPayloadHash(input),
    },
  };
}
