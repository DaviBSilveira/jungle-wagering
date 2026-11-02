import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ArgumentsHost, Catch, ExceptionFilter, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Request, Response } from 'express';
import { wagerPayloadHash } from './application/canonical';
import { uuidv7 } from './application/ids';
import { OpenWalletService } from './application/open-wallet.service';
import { ProcessWagerService } from './application/process-wager.service';
import { parseIdempotencyKey, parseWagerInput } from './application/wager-input';
import { WalletReadService } from './application/wallet-read.service';
import {
  DuplicateWalletError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from './domain/errors';
import { SqsGateway } from './infrastructure/sqs';
import { Metrics } from './infrastructure/metrics';
import { errorFields, isTransientError, log } from './log';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletService,
    private readonly reads: WalletReadService,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (body === null || typeof body !== 'object') throw new InvalidPayloadError('corpo inválido');
    const raw = body as { playerId?: unknown; initialBalance?: { amount: string; currency: string } };
    if (typeof raw.playerId !== 'string' || !raw.initialBalance) throw new InvalidPayloadError('wallet inválida');
    const opened = await this.openWallet.open({
      playerId: raw.playerId,
      initialBalance: raw.initialBalance,
      correlationId: req.correlationId ?? uuidv7(),
    });
    res.status(201);
    return opened;
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.reads.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reads.ledger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.reads.reconcile(walletId);
  }
}

@Controller()
export class WageringController {
  constructor(
    private readonly wagers: ProcessWagerService,
    private readonly reads: WalletReadService,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseWagerInput(body);
    const idempotencyKey = parseIdempotencyKey(key);
    const result = await this.wagers.execute(input, {
      idempotencyKey,
      correlationId: req.correlationId ?? uuidv7(),
      source: 'http',
      payloadHash: wagerPayloadHash(input),
    });
    res.status(result.httpStatus);
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    };
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string) {
    return this.reads.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.reads.getByExternal(providerId, externalTransactionId);
  }
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    let postgres = false;
    try {
      await this.orm.em.fork().getConnection().execute('select 1');
      postgres = true;
    } catch (err) {
      log('warn', 'postgres fora do ready', errorFields(err));
    }
    const sqs = await this.sqs.probe();
    if (!postgres || !sqs) {
      res.status(503);
      return { status: 'down', postgres, sqs };
    }
    return { status: 'ok', postgres, sqs };
  }
}

@Controller()
export class MetricsController {
  constructor(
    private readonly metrics: Metrics,
    private readonly orm: MikroORM,
  ) {}

  @Get('metrics')
  async render(@Res() res: Response) {
    const body = await this.metrics.render(this.orm);
    res.type('text/plain; version=0.0.4').send(body);
  }
}

@Catch()
@Injectable()
export class ErrorsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof InvalidPayloadError) {
      res.status(400).json({ error: 'INVALID_PAYLOAD', message: exception.message });
      return;
    }
    if (exception instanceof IdempotencyConflictError) {
      res.status(409).json({ error: 'IDEMPOTENCY_PAYLOAD_MISMATCH', message: exception.message });
      return;
    }
    if (exception instanceof DuplicateWalletError) {
      res.status(409).json({ error: 'DUPLICATE_WALLET', message: exception.message });
      return;
    }
    if (exception instanceof WalletNotFoundError) {
      res.status(404).json({ error: 'WALLET_NOT_FOUND', message: exception.message });
      return;
    }
    if (exception instanceof TransactionNotFoundError) {
      res.status(404).json({ error: 'TRANSACTION_NOT_FOUND', message: exception.message });
      return;
    }
    if (isTransientError(exception)) {
      log('error', 'falha transitória', errorFields(exception));
      res.status(503).json({ error: 'TRANSIENT_FAILURE', message: 'tenta de novo' });
      return;
    }
    log('error', 'erro não tratado', errorFields(exception));
    res.status(500).json({ error: 'INTERNAL', message: 'erro interno' });
  }
}
