import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { OpenWalletService } from './application/open-wallet.service';
import { ProcessWagerService } from './application/process-wager.service';
import { ProviderIdentity } from './application/provider-identity';
import { WalletReadService } from './application/wallet-read.service';
import { ormConfig } from './infrastructure/db/orm';
import { Metrics } from './infrastructure/metrics';
import { SqsGateway } from './infrastructure/sqs';
import {
  DomainEventConsumer,
  OutboxPublisher,
  PendingReferenceWorker,
  WagerConsumer,
  WorkerRuntime,
} from './infrastructure/workers';
import { ErrorsFilter, HealthController, MetricsController, WageringController, WalletsController } from './http';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig())],
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    Metrics,
    ProviderIdentity,
    SqsGateway,
    ProcessWagerService,
    OpenWalletService,
    WalletReadService,
    OutboxPublisher,
    WagerConsumer,
    DomainEventConsumer,
    PendingReferenceWorker,
    WorkerRuntime,
    { provide: APP_FILTER, useClass: ErrorsFilter },
  ],
})
export class AppModule {}
