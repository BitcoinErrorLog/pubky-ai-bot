import { createClient, RedisClientType } from 'redis';
import logger from '@/utils/logger';
import appConfig from '@/config';

export class RedisConnection {
  private client: RedisClientType;

  constructor() {
    this.client = createClient({ url: appConfig.redis.url });

    this.client.on('error', (err) => {
      logger.error('Redis client error:', err);
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
    logger.info('Redis connections established');
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    logger.info('Redis connections closed');
  }

  getClient(): RedisClientType {
    return this.client;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch (error) {
      logger.error('Redis health check failed:', error);
      return false;
    }
  }
}

export const redis = new RedisConnection();
