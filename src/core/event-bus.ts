import { EventEnvelope, EventName } from './events';
import { RedisStreams } from '@/infrastructure/redis/streams';
import { generateId } from '@/utils/ids';
import { getCurrentTimestamp } from '@/utils/time';
import logger from '@/utils/logger';
import appConfig from '@/config';

export class EventBus {
  private streams: RedisStreams;
  private readonly STREAM_PREFIX = 'pubky';
  private readonly DLQ_STREAM = 'pubky:dlq';
  private stopped = false;
  private readonly retryCounts = new Map<string, number>();
  private loopPromises: Promise<void>[] = [];

  constructor() {
    this.streams = new RedisStreams();
  }

  private getStreamKey(eventType: EventName): string {
    const baseName = eventType.replace('.v1', '').replace('.', '_');
    return `${this.STREAM_PREFIX}:${baseName}`;
  }

  async emit<T>(eventType: EventName, data: T, options?: {
    correlationId?: string;
    key?: string;
  }): Promise<string> {
    const envelope: EventEnvelope<T> = {
      id: generateId(),
      type: eventType,
      ts: getCurrentTimestamp(),
      correlationId: options?.correlationId,
      key: options?.key,
      data
    };

    const streamKey = this.getStreamKey(eventType);
    const messageId = await this.streams.addToStream(streamKey, {
      envelope: JSON.stringify(envelope)
    });

    logger.debug(`Emitted event ${eventType}`, {
      eventId: envelope.id,
      correlationId: envelope.correlationId,
      messageId
    });

    return messageId;
  }

  async subscribe<T>(
    eventType: EventName,
    groupName: string,
    consumerName: string,
    handler: (envelope: EventEnvelope<T>) => Promise<void>
  ): Promise<void> {
    const streamKey = this.getStreamKey(eventType);

    await this.streams.createConsumerGroup(streamKey, groupName);

    const idleMs = (appConfig.eventBus?.pendingIdleSeconds ?? 30) * 1000;
    const reclaimed = await this.streams.reclaimPending(streamKey, groupName, consumerName, idleMs);
    for (const message of reclaimed) {
      await this.handleMessage(streamKey, groupName, message, handler);
    }

    logger.info(`Subscribed to ${eventType} with group ${groupName}, consumer ${consumerName}`);

    const loop = this.consumeLoop(streamKey, groupName, consumerName, handler);
    this.loopPromises.push(loop);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.race([
      Promise.all(this.loopPromises),
      new Promise<void>((resolve) => setTimeout(resolve, 500))
    ]);
  }

  private async consumeLoop<T>(
    streamKey: string,
    groupName: string,
    consumerName: string,
    handler: (envelope: EventEnvelope<T>) => Promise<void>
  ): Promise<void> {
    while (!this.stopped) {
      try {
        const messages = await this.streams.readFromGroup(streamKey, {
          groupName,
          consumerName,
          count: 5,
          block: 100
        });

        for (const message of messages) {
          if (this.stopped) break;
          await this.handleMessage(streamKey, groupName, message, handler);
        }
      } catch (error) {
        if (this.stopped) break;
        logger.error(`Error in consume loop for ${streamKey}:`, error);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  private async handleMessage<T>(
    streamKey: string,
    groupName: string,
    message: { id: string; fields: Record<string, string> },
    handler: (envelope: EventEnvelope<T>) => Promise<void>
  ): Promise<void> {
    try {
      const envelope = JSON.parse(message.fields.envelope) as EventEnvelope<T>;

      logger.debug(`Processing event ${envelope.type}`, {
        eventId: envelope.id,
        correlationId: envelope.correlationId,
        messageId: message.id
      });

      await handler(envelope);
      await this.streams.acknowledgMessage(streamKey, groupName, message.id);
      this.retryCounts.delete(message.id);

      logger.debug(`Completed event ${envelope.type}`, {
        eventId: envelope.id,
        messageId: message.id
      });
    } catch (error) {
      const attempts = (this.retryCounts.get(message.id) || 0) + 1;
      this.retryCounts.set(message.id, attempts);
      const maxAttempts = appConfig.eventBus?.maxAttempts ?? 3;

      logger.error(`Error processing message ${message.id} (attempt ${attempts}/${maxAttempts}):`, error);

      if (attempts >= maxAttempts) {
        await this.streams.moveToDLQ(
          streamKey,
          this.DLQ_STREAM,
          groupName,
          message.id,
          { error: error instanceof Error ? error.message : 'Unknown error', attempts }
        );
        this.retryCounts.delete(message.id);
      }
    }
  }

  async initializeStreams(): Promise<void> {
    await this.streams.createConsumerGroup(this.DLQ_STREAM, 'dlq-processors', '0');
    logger.info('Event bus initialized');
  }
}
