import {
  Controller,
  Get,
  type INestApplication,
  type INestApplicationContext,
  Module,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getSharedConfigToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { AppModule } from '../src/app.module.js';
import type { AuthUser } from '../src/auth/auth-user.js';
import { CurrentUser } from '../src/auth/current-user.decorator.js';
import { AppConfig } from '../src/config/app-config.js';
import { configureApp } from '../src/configure-app.js';
import { useRequestMetrics } from '../src/metrics/request-metrics.js';
import { RequirePermission } from '../src/permissions/require-permission.decorator.js';
import { bullConnection } from '../src/queues/queues.module.js';
import { REDIS } from '../src/redis/redis.module.js';

/** HTTP-only test endpoints (kept out of the GraphQL schema on purpose). */
@Controller('__test')
class SeamsTestController {
  @Get('whoami')
  whoami(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @RequirePermission('bo:users:modify')
  @Get('modify-users')
  modifyUsers(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [SeamsTestController] })
class SeamsTestModule {}

/**
 * Boots the real AppModule (+ test endpoints) with optional env overrides. `queuePrefix` replaces
 * the BullMQ key prefix, so a scenario owns its queue keys.
 */
export async function createApp(
  env: Record<string, string> = {},
  { queuePrefix }: { queuePrefix?: string } = {},
): Promise<INestApplication> {
  // Gateway only by default, so e2e runs do not start background workers.
  const config = AppConfig.fromEnv({ ...process.env, ROLE: 'GATEWAY', ...env });
  let builder = Test.createTestingModule({
    imports: [AppModule.forRoles(config), SeamsTestModule],
  })
    .overrideProvider(AppConfig)
    .useValue(config);
  if (queuePrefix) {
    builder = builder
      .overrideProvider(getSharedConfigToken())
      .useValue({ connection: bullConnection(config.redisUrl), prefix: queuePrefix });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: ['error', 'warn'],
  });
  configureApp(app);
  useRequestMetrics(app);
  try {
    await app.init();
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  return app;
}

/** Bounded wait for `ready`; unlike `once`, errors while reconnecting do not end it early. */
export function waitForReady(client: Redis, timeoutMs = 10_000): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error(`Redis not ready after ${timeoutMs} ms`));
    }, timeoutMs);
    client.once('ready', onReady);
  });
}

/** The command client connects in the background and fails commands until it is ready. */
export function redisReady(app: INestApplicationContext): Promise<void> {
  return waitForReady(app.get<Redis>(REDIS));
}
