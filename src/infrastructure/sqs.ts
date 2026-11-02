import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { env } from '../config';
import { errorFields, log } from '../log';

@Injectable()
export class SqsGateway {
  private readonly client = new SQSClient({
    region: env().awsRegion,
    endpoint: env().sqsEndpoint,
    credentials: {
      accessKeyId: env().awsAccessKeyId,
      secretAccessKey: env().awsSecretAccessKey,
    },
  });

  private readonly urls = new Map<string, string>();
  private ready = false;

  async ensureQueues(): Promise<void> {
    if (this.ready) return;
    const cfg = env();
    await this.create(cfg.wagerDlq, {});
    await this.create(cfg.eventsDlq, {});
    const wagerDlqArn = await this.arn(cfg.wagerDlq);
    const eventsDlqArn = await this.arn(cfg.eventsDlq);
    await this.create(cfg.wagerQueue, redrive(wagerDlqArn));
    await this.create(cfg.eventsQueue, redrive(eventsDlqArn));
    this.ready = true;
  }

  async send(queueName: string, body: string, groupId: string, dedupId: string): Promise<void> {
    await this.ensureQueues();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.url(queueName),
        MessageBody: body,
        MessageGroupId: groupId.slice(0, 128),
        MessageDeduplicationId: dedupId.slice(0, 128),
      }),
    );
  }

  async receive(queueName: string): Promise<Message[]> {
    await this.ensureQueues();
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.url(queueName),
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: env().sqsWaitSeconds,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return result.Messages ?? [];
  }

  async remove(queueName: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.url(queueName),
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async changeVisibility(queueName: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.url(queueName),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async probe(): Promise<boolean> {
    try {
      await this.ensureQueues();
      await this.url(env().wagerQueue);
      return true;
    } catch (err) {
      log('warn', 'sqs indisponível', errorFields(err));
      this.ready = false;
      return false;
    }
  }

  private async create(name: string, extra: Record<string, string>): Promise<void> {
    await this.client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '30',
          ...extra,
        },
      }),
    );
  }

  private async arn(name: string): Promise<string> {
    return `arn:aws:sqs:${env().awsRegion}:000000000000:${name}`;
  }

  private async url(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error(`fila ${name} sem url`);
    this.urls.set(name, result.QueueUrl);
    return result.QueueUrl;
  }
}

function redrive(arn: string): Record<string, string> {
  return {
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '5' }),
  };
}
