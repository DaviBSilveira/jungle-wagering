import 'reflect-metadata';
import { UnderscoreNamingStrategy } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { env } from '../../config';
import { Migration20260729150000 } from './Migration20260729150000';
import { InboxRow, LedgerRow, OutboxRow, WagerRow, WalletRow } from './rows';

export function ormConfig(overrides: { clientUrl?: string; schema?: string } = {}) {
  const cfg = env();
  const schema = overrides.schema;
  return defineConfig({
    clientUrl: overrides.clientUrl ?? cfg.databaseUrl,
    schema,
    pool: schema
      ? {
          afterCreate(conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, conn: unknown) => void) {
            conn.query(`set search_path to "${schema}"`, (err) => done(err, conn));
          },
        }
      : undefined,
    entities: [WalletRow, WagerRow, LedgerRow, InboxRow, OutboxRow],
    namingStrategy: UnderscoreNamingStrategy,
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: [
        {
          name: 'Migration20260729150000',
          class: Migration20260729150000,
        },
      ],
    },
    debug: false,
    allowGlobalContext: false,
  });
}
