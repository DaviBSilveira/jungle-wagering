import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/core';
import type { FailureCode } from '../../domain/errors';
import { LedgerDirection } from '../../domain/ledger';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';

@Entity({ tableName: 'wallets' })
export class WalletRow {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ columnType: 'numeric(18,2)', type: 'decimal', precision: 18, scale: 2 })
  balance!: string;

  @Property()
  version!: number;

  @Property()
  createdAt!: Date;

  @Property()
  updatedAt!: Date;
}

@Entity({ tableName: 'wager_transactions' })
export class WagerRow {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property()
  providerId!: string;

  @Property()
  externalTransactionId!: string;

  @Property()
  idempotencyKey!: string;

  @Property()
  payloadHash!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property()
  roundId!: string;

  @Property()
  gameId!: string;

  @Enum(() => WagerTransactionKind)
  kind!: WagerTransactionKind;

  @Property({ columnType: 'numeric(18,2)', type: 'decimal', precision: 18, scale: 2 })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ nullable: true })
  referenceExternalTransactionId?: string;

  @Enum(() => WagerTransactionStatus)
  status!: WagerTransactionStatus;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ nullable: true })
  failureCode?: FailureCode;

  @Property({ columnType: 'numeric(18,2)', type: 'decimal', precision: 18, scale: 2, nullable: true })
  resultBalanceAmount?: string;

  @Property({ length: 3, nullable: true })
  resultBalanceCurrency?: string;

  @Property()
  attemptCount: number = 0;

  @Property({ nullable: true })
  nextAttemptAt?: Date;

  @Property()
  createdAt!: Date;

  @Property({ nullable: true })
  processedAt?: Date;
}

@Entity({ tableName: 'wallet_ledger_entries' })
export class LedgerRow {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  transactionId!: string;

  @Enum(() => LedgerDirection)
  direction!: LedgerDirection;

  @Property({ columnType: 'numeric(18,2)', type: 'decimal', precision: 18, scale: 2 })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ columnType: 'numeric(18,2)', type: 'decimal', precision: 18, scale: 2 })
  balanceBefore!: string;

  @Property({ columnType: 'numeric(18,2)', type: 'decimal', precision: 18, scale: 2 })
  balanceAfter!: string;

  @Property()
  createdAt!: Date;
}

@Entity({ tableName: 'inbox_messages' })
export class InboxRow {
  @PrimaryKey()
  consumerName!: string;

  @PrimaryKey()
  messageId!: string;

  @Property()
  payloadHash!: string;

  @Property()
  receivedAt!: Date;

  @Property({ nullable: true })
  processedAt?: Date;
}

@Entity({ tableName: 'outbox_messages' })
export class OutboxRow {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property()
  aggregateId!: string;

  @Property()
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property()
  occurredAt!: Date;

  @Property()
  attempts: number = 0;

  @Property({ nullable: true })
  nextAttemptAt?: Date;

  @Property({ nullable: true })
  publishedAt?: Date;

  @Property({ nullable: true })
  claimToken: string | null = null;

  @Property({ nullable: true })
  claimExpiresAt: Date | null = null;
}
