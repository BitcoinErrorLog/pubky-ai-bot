import { RedisClientType } from 'redis';
import logger from '@/utils/logger';
import { redis } from './connection';

export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

export interface ConsumerGroupOptions {
  groupName: string;
  consumerName: string;
  count?: number;
  block?: number;
}

export class RedisStreams {
  private client: RedisClientType;

  constructor() {
    this.client = redis.getClient();
  }

  async addToStream(streamKey: string, fields: Record<string, any>): Promise<string> {
    try {
      const messageId = await this.client.xAdd(streamKey, '*', fields);
      logger.debug(`Added message to stream ${streamKey}: ${messageId}`);
      return messageId;
    } catch (error) {
      logger.error(`Failed to add message to stream ${streamKey}:`, error);
      throw error;
    }
  }

  async createConsumerGroup(
    streamKey: string,
    groupName: string,
    startFrom: string = '$'
  ): Promise<void> {
    try {
      await this.client.xGroupCreate(streamKey, groupName, startFrom, { MKSTREAM: true });
      logger.info(`Created consumer group ${groupName} for stream ${streamKey}`);
    } catch (error: any) {
      if (error.message?.includes('BUSYGROUP')) {
        logger.debug(`Consumer group ${groupName} already exists for stream ${streamKey}`);
      } else {
        logger.error(`Failed to create consumer group ${groupName} for stream ${streamKey}:`, error);
        throw error;
      }
    }
  }

  async reclaimPending(
    streamKey: string,
    groupName: string,
    consumerName: string,
    minIdleMs: number
  ): Promise<StreamMessage[]> {
    try {
      const result = await this.client.xAutoClaim(
        streamKey,
        groupName,
        consumerName,
        minIdleMs,
        '0-0',
        { COUNT: 100 }
      );
      const messages = (result as any)?.messages ?? [];
      return messages.map((msg: any) => ({
        id: msg.id,
        fields: msg.message as Record<string, string>
      }));
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (msg.includes('NOGROUP') || msg.includes('unknown command')) {
        logger.debug(`No pending messages to reclaim on ${streamKey}`);
        return [];
      }
      logger.warn(`Failed to reclaim pending messages on ${streamKey}:`, error);
      return [];
    }
  }

  async readFromGroup(
    streamKey: string,
    options: ConsumerGroupOptions
  ): Promise<StreamMessage[]> {
    try {
      const messages = await this.client.xReadGroup(
        options.groupName,
        options.consumerName,
        { key: streamKey, id: '>' },
        { COUNT: options.count || 10, BLOCK: options.block !== undefined ? options.block : 100 }
      );

      if (!messages || messages.length === 0) {
        return [];
      }

      const streamMessages = messages[0]?.messages || [];
      return streamMessages.map(msg => ({
        id: msg.id,
        fields: msg.message as Record<string, string>
      }));
    } catch (error) {
      logger.error(`Failed to read from group ${options.groupName} on stream ${streamKey}:`, error);
      throw error;
    }
  }

  async acknowledgMessage(
    streamKey: string,
    groupName: string,
    messageId: string
  ): Promise<void> {
    try {
      await this.client.xAck(streamKey, groupName, messageId);
      logger.debug(`Acknowledged message ${messageId} in group ${groupName}`);
    } catch (error) {
      logger.error(`Failed to acknowledge message ${messageId}:`, error);
      throw error;
    }
  }

  async moveToDLQ(
    sourceStream: string,
    dlqStream: string,
    groupName: string,
    messageId: string,
    errorData: any
  ): Promise<void> {
    try {
      await this.addToStream(dlqStream, {
        originalMessageId: messageId,
        sourceStream,
        errorData: JSON.stringify(errorData),
        movedAt: new Date().toISOString()
      });

      await this.acknowledgMessage(sourceStream, groupName, messageId);

      logger.info(`Moved message ${messageId} from ${sourceStream} to DLQ`);
    } catch (error) {
      logger.error(`Failed to move message ${messageId} to DLQ:`, error);
      throw error;
    }
  }
}
