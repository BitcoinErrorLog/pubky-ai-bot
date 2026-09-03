import { Router } from 'express';
import { asyncHandler } from '@/api/error-handler';
import logger from '@/utils/logger';
import appConfig from '@/config';
import { setKillSwitch } from '@/services/kill-switch';

interface HealthServices {
  db: { healthCheck: () => Promise<boolean> };
  redis: { healthCheck: () => Promise<boolean> };
  pubky?: { healthCheck: () => Promise<boolean> };
  router?: { healthCheck: () => Promise<boolean> };
  summaryWorker?: { healthCheck: () => Promise<boolean> };
  factcheckWorker?: { healthCheck: () => Promise<boolean> };
  poller?: { healthCheck: () => Promise<boolean> };
}

function requireAdmin(req: any, res: any): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    res.status(403).json({ error: 'admin disabled: ADMIN_TOKEN is unset' });
    return false;
  }
  const header = req.get('x-admin-token') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (header !== token) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

export function createHealthRouter(services: HealthServices) {
  const router = Router();

  router.get('/health', asyncHandler(async (req, res) => {
    const startTime = Date.now();

    const checks = await Promise.allSettled([
      checkService('database', services.db),
      checkService('redis', services.redis)
    ]);

    const serviceChecks = checks.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const serviceNames = ['database', 'redis'];
      return {
        service: serviceNames[index] || 'unknown',
        status: 'error',
        healthy: false,
        error: result.reason instanceof Error ? result.reason.message : 'Unknown error'
      };
    });

    const allHealthy = serviceChecks.every(check => check.healthy);
    const overallStatus = allHealthy ? 'healthy' : 'unhealthy';

    const response = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      responseTime: Date.now() - startTime,
      pubky: {
        network: appConfig.pubky.network || 'testnet'
      },
      services: serviceChecks.reduce((acc, check) => {
        acc[check.service] = {
          status: check.status,
          healthy: check.healthy,
          ...(((check as any).error) && { error: (check as any).error })
        };
        return acc;
      }, {} as Record<string, any>)
    };

    res.status(allHealthy ? 200 : 503).json(response);

    if (!allHealthy) {
      logger.warn('Health check failed', {
        unhealthyServices: serviceChecks.filter(c => !c.healthy).map(c => c.service)
      });
    }
  }));

  const readyHandler = asyncHandler(async (req, res) => {
    const criticalServices = [services.db, services.redis];
    const checks = await Promise.allSettled(
      criticalServices.map((service, index) => {
        const names = ['database', 'redis'];
        return checkService(names[index], service);
      })
    );

    const allReady = checks.every(result =>
      result.status === 'fulfilled' && result.value.healthy
    );

    if (allReady) {
      res.status(200).json({
        status: 'ready',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({
        status: 'not_ready',
        timestamp: new Date().toISOString()
      });
    }
  });

  const liveHandler = asyncHandler(async (req, res) => {
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  });

  router.get('/health/ready', readyHandler);
  router.get('/health/live', liveHandler);
  router.get('/ready', readyHandler);
  router.get('/live', liveHandler);

  router.post('/admin/kill', asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    await setKillSwitch(true);
    res.status(200).json({ ok: true, kill: true });
  }));

  router.post('/admin/resume', asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    await setKillSwitch(false);
    res.status(200).json({ ok: true, kill: false });
  }));

  return router;
}

async function checkService(
  name: string,
  service: { healthCheck: () => Promise<boolean> }
): Promise<{
  service: string;
  status: string;
  healthy: boolean;
  error?: string;
}> {
  try {
    const healthy = await service.healthCheck();
    return {
      service: name,
      status: healthy ? 'healthy' : 'unhealthy',
      healthy
    };
  } catch (error) {
    return {
      service: name,
      status: 'error',
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
