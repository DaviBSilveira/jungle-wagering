import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { uuidv7 } from './application/ids';
import { env } from './config';
import { WorkerRuntime } from './infrastructure/workers';
import { log } from './log';
import { MikroORM } from '@mikro-orm/postgresql';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  const orm = app.get(MikroORM);
  await orm.migrator.up();

  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-correlation-id');
    const correlationId = incoming && incoming.trim() !== '' ? incoming.trim() : uuidv7();
    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    res.on('finish', () => {
      log('info', 'http', {
        correlationId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
      });
    });
    next();
  });

  const runtime = app.get(WorkerRuntime);
  app.enableShutdownHooks();
  await app.listen(env().port);
  log('info', 'api no ar', { instanceId: env().instanceId, port: env().port });

  const shutdown = async (signal: string) => {
    log('info', 'encerrando', { signal, instanceId: env().instanceId });
    await runtime.onModuleDestroy();
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  log('error', 'não subi', { error: err instanceof Error ? err.message : 'erro' });
  process.exit(1);
});
