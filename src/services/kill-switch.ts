import { redis } from '@/infrastructure/redis/connection';
import logger from '@/utils/logger';

export const KILL_SWITCH_KEY = 'jeb:kill_switch';

export async function isKillSwitchActive(): Promise<boolean> {
  if (process.env.BOT_DISABLED === '1') {
    return true;
  }
  try {
    const value = await redis.getClient().get(KILL_SWITCH_KEY);
    return value === '1';
  } catch (error) {
    logger.error('Kill switch Redis check failed — treating as active (fail closed)', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return true;
  }
}

export async function setKillSwitch(active: boolean): Promise<void> {
  const client = redis.getClient();
  if (active) {
    await client.set(KILL_SWITCH_KEY, '1');
  } else {
    await client.del(KILL_SWITCH_KEY);
  }
}
