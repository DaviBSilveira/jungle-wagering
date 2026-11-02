export function env() {
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wager',
    sqsEndpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    awsRegion: process.env.AWS_REGION ?? 'us-east-1',
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    wagerQueue: process.env.SQS_WAGER_QUEUE ?? 'wager-transactions.fifo',
    wagerDlq: process.env.SQS_WAGER_DLQ ?? 'wager-transactions-dlq.fifo',
    eventsQueue: process.env.SQS_EVENTS_QUEUE ?? 'domain-events.fifo',
    eventsDlq: process.env.SQS_EVENTS_DLQ ?? 'domain-events-dlq.fifo',
    workersEnabled: (process.env.WORKERS_ENABLED ?? 'true') !== 'false',
    outboxPollMs: Number(process.env.OUTBOX_POLL_MS ?? 400),
    consumerPollMs: Number(process.env.CONSUMER_POLL_MS ?? 400),
    pendingPollMs: Number(process.env.PENDING_POLL_MS ?? 400),
    pendingMaxAttempts: Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 8),
    pendingBaseDelayMs: Number(process.env.PENDING_REFERENCE_BASE_DELAY_MS ?? 500),
    outboxRetryBaseMs: Number(process.env.OUTBOX_RETRY_BASE_MS ?? 500),
    sqsWaitSeconds: Number(process.env.SQS_WAIT_SECONDS ?? 1),
    instanceId: process.env.INSTANCE_ID ?? `local-${process.pid}`,
  };
}
