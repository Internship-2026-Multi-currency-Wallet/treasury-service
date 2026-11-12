import { once } from 'node:events';
import { jest } from '@jest/globals';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { getLoggerToken, type PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DiagnosticsModule } from '../src/diagnostics/diagnostics.module.js';
import { EventPublisher, redisName } from '../src/events/event-bus.js';
import {
  HEARTBEAT_JOB,
  HEARTBEAT_QUEUE,
  HEARTBEAT_SCHEDULER_ID,
} from '../src/heartbeat/heartbeat.constants.js';
import { HeartbeatProcessor } from '../src/heartbeat/heartbeat.processor.js';
import { Metrics } from '../src/metrics/metrics.js';
import { bullConnection } from '../src/queues/queues.module.js';
import { closeRedis, watchRedisConnection } from '../src/redis/redis-connection.js';
import { createRedis } from '../src/redis/redis.module.js';
import { createApp, waitForReady } from './create-app.js';
import { RedisProxy } from './redis-proxy.js';
import { bearer } from './tokens.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects if `promise` does not settle in time; the timer is always cleared. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every cleanup step even if an earlier one fails, then reports the first failure. */
async function cleanUp(...steps: (() => Promise<unknown> | undefined)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

/** Deletes only the keys of one scenario's queue prefix; never flushes the database. */
async function deleteQueueKeys(redisUrl: string, prefix: string): Promise<void> {
  const redis = new Redis(redisUrl);
  try {
    await waitForReady(redis);
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } finally {
    await closeRedis(redis);
  }
}

/**
 * Redis outages against real MySQL and real Redis. The app talks to Redis through a local TCP
 * proxy that the test stops and starts on the same port; the target Redis is never stopped or
 * flushed. Delivery is observed through the "system.ping received" log of DiagnosticsModule.
 */
describe('Redis outage (e2e, real Redis behind a controllable proxy)', () => {
  const sharedRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const run = `e2e-outage-${process.pid}-${Date.now()}`;
  let proxy: RedisProxy | undefined;
  let app: INestApplication | undefined;
  let direct: Redis | undefined;
  let publisher: EventPublisher;
  let received: { mock: { calls: unknown[][] } };
  let consoleError: jest.Spied<typeof console.error>;
  let seq = 0;

  const server = () => app!.getHttpServer() as App;
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const start = Date.now();
    const result = await fn();
    return [result, Date.now() - start];
  };
  const deliveries = (from: string) =>
    received.mock.calls.filter(
      ([fields]) => (fields as { from?: string } | undefined)?.from === from,
    ).length;
  const published = async (): Promise<number> => {
    const counter = app!.get(Metrics).registry.getSingleMetric('events_published_total');
    const values = (await counter?.get())?.values ?? [];
    return values.find((v) => v.labels.type === 'system.ping')?.value ?? 0;
  };
  // Anonymous GraphQL requests from one IP; the app's anonymous limit is 3 per window.
  const anonymous = (ip: string) =>
    request(server())
      .post('/graphql')
      .set('X-Forwarded-For', ip)
      .send({ query: '{ health { service } }' });
  const refused = (body: unknown) =>
    (body as { errors?: { extensions: { code?: string } }[] }).errors?.[0]?.extensions.code ===
    'TOO_MANY_REQUESTS';

  /** Publishes system.ping (directly to the target Redis) until the app's handler logs one. */
  async function waitForDelivery(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const from = `${run}-probe-${++seq}`;
      await publisher.publish('system.ping', { v: 1, from, ts: new Date().toISOString() });
      await sleep(250);
      if (deliveries(from) > 0) return;
    }
    throw new Error('system.ping was not delivered after Redis came back');
  }

  /** One ping must be handled exactly once (no duplicated handlers after reconnects). */
  async function expectExactlyOnce(): Promise<void> {
    const from = `${run}-once-${++seq}`;
    await publisher.publish('system.ping', { v: 1, from, ts: new Date().toISOString() });
    await sleep(500);
    expect(deliveries(from)).toBe(1);
  }

  async function waitForHealth(redis: 'UP' | 'DOWN', timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(server()).get('/health');
      if (res.body.redis === redis) return;
      await sleep(200);
    }
    throw new Error(`health never reported redis=${redis}`);
  }

  beforeAll(async () => {
    consoleError = jest.spyOn(console, 'error');
    proxy = await RedisProxy.reserve(sharedRedisUrl); // reserved, NOT listening: Redis is "down"
    direct = new Redis(sharedRedisUrl);
    publisher = new EventPublisher(direct, 'local');
    await waitForReady(direct);
  });

  afterAll(async () => {
    await app?.close();
    await proxy?.stop();
    if (direct) await closeRedis(direct);
    consoleError.mockRestore();
    // `disconnect()` on a client whose Redis is unreachable leaves the ioredis safety timer
    // (`disconnectTimeout`, 2 s) running; let it expire so Jest exits cleanly.
    await sleep(2100);
  });

  it('starts and listens while Redis is unreachable', async () => {
    const [created, ms] = await timed(() =>
      createApp({
        APP_ENV: 'local',
        REDIS_URL: proxy!.url,
        THROTTLE_LIMIT_ANONYMOUS: '3',
        THROTTLE_TTL_SECONDS: '2',
      }),
    );
    app = created;
    expect(ms).toBeLessThan(10_000);
    await app.listen(0, '127.0.0.1');
    received = jest.spyOn(app.get<PinoLogger>(getLoggerToken(DiagnosticsModule.name)), 'info');
  });

  it('GET /health answers 200 degraded (db UP, redis DOWN) within a bounded time', async () => {
    const [res, ms] = await timed(() => request(server()).get('/health'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'UP', redis: 'DOWN' });
    expect(ms).toBeLessThan(3000);
  });

  it('POST /diagnostics/ping answers 503 within a bounded time and counts no publication', async () => {
    const before = await published();
    const [res, ms] = await timed(() =>
      request(server()).post('/diagnostics/ping').set('Authorization', bearer()),
    );
    expect(res.status).toBe(503);
    expect(ms).toBeLessThan(3000);
    expect(await published()).toBe(before);
  });

  it('lets requests through without a limit while Redis is down', async () => {
    const ip = `10.99.${process.pid % 256}.1`;
    for (let i = 0; i < 5; i++) expect(refused((await anonymous(ip)).body)).toBe(false);
  });

  it('delivers system.ping once Redis appears at the same endpoint (cold start)', async () => {
    await proxy!.start();
    await waitForHealth('UP');
    await waitForDelivery();
    await expectExactlyOnce();
    const res = await request(server()).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'UP', redis: 'UP' });
    const before = await published();
    await request(server())
      .post('/diagnostics/ping')
      .set('Authorization', bearer())
      .expect(200, { published: true });
    expect(await published()).toBe(before + 1);
  });

  it('enforces the rate limit again after Redis recovers', async () => {
    // A storage failure pauses the limiter for a cooldown, so poll with fresh IPs.
    const deadline = Date.now() + 20_000;
    let enforced = false;
    for (let n = 0; !enforced && Date.now() < deadline; n++) {
      const ip = `10.98.${process.pid % 256}.${n % 256}`;
      for (let i = 0; i < 4; i++) enforced = refused((await anonymous(ip)).body);
      if (!enforced) await sleep(500);
    }
    expect(enforced).toBe(true);
  });

  it('resumes delivery after losing a working Redis, without duplicated handlers', async () => {
    await proxy!.stop();
    await waitForHealth('DOWN');
    const [res, ms] = await timed(() => request(server()).get('/health'));
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(3000);

    await proxy!.start();
    await waitForHealth('UP');
    await waitForDelivery();
    await expectExactlyOnce();

    // A second outage: still exactly one handler.
    await proxy!.stop();
    await waitForHealth('DOWN');
    await proxy!.start();
    await waitForDelivery();
    await expectExactlyOnce();
  });

  it('shuts down within a bounded time while Redis is unreachable', async () => {
    await proxy!.stop();
    await waitForHealth('DOWN');
    const [, ms] = await timed(() => app!.close());
    expect(ms).toBeLessThan(5000);
    app = undefined;
  });

  it('never let ioredis or BullMQ print unhandled error events', () => {
    // BullMQ prints an unhandled queue error object; ioredis prints an "[ioredis]" line.
    const redisErrors = consoleError.mock.calls.filter(
      (args: unknown[]) => args[0] instanceof Error || String(args[0]).includes('[ioredis]'),
    );
    expect(redisErrors).toEqual([]);
  });
});

describe('command client during an outage (e2e, real Redis behind a controllable proxy)', () => {
  const sharedRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const channel = redisName('e2e', `late-publish-${process.pid}-${Date.now()}`);
  let proxy: RedisProxy | undefined;
  let observer: Redis | undefined;
  const delivered: string[] = [];
  const quietLogger = () => ({ warn: jest.fn(), debug: jest.fn(), info: jest.fn() });

  beforeAll(async () => {
    proxy = await RedisProxy.reserve(sharedRedisUrl);
    observer = new Redis(sharedRedisUrl);
    await observer.subscribe(channel);
    observer.on('message', (_channel: string, message: string) => delivered.push(message));
  });

  afterAll(async () => {
    await proxy?.stop();
    if (observer) await closeRedis(observer);
  });

  it('never sends a publish that failed during the outage, and recovers for later commands', async () => {
    const client = createRedis(proxy!.url); // the app's command-client options
    client.on('error', () => undefined);
    let reconnects = 0;
    client.on('reconnecting', () => reconnects++);
    try {
      // Past the first maxRetriesPerRequest flush: an offline queue would now keep the
      // command until recovery, long after commandTimeout rejected it.
      const deadline = Date.now() + 10_000;
      while (reconnects < 4 && Date.now() < deadline) await sleep(20);
      expect(reconnects).toBeGreaterThanOrEqual(4);
      const started = Date.now();
      await expect(client.publish(channel, 'during-outage')).rejects.toThrow(/isn't writeable/);
      expect(Date.now() - started).toBeLessThan(500);

      await proxy!.start();
      await waitForReady(client);
      await sleep(300);
      expect(delivered).toEqual([]);

      await expect(client.publish(channel, 'after-recovery')).resolves.toBe(1);
      await sleep(200);
      expect(delivered).toEqual(['after-recovery']);
    } finally {
      client.disconnect();
    }
  });

  it('does not report QUIT or disconnect() of a ready connection as an outage', async () => {
    await proxy!.start();
    const closers = [
      async (c: Redis) => void (await c.quit()),
      (c: Redis) => Promise.resolve(c.disconnect()),
    ];
    for (const close of closers) {
      const client = createRedis(proxy!.url);
      const logger = quietLogger();
      watchRedisConnection(client, logger as unknown as PinoLogger, 'command');
      try {
        await waitForReady(client);
        const ended = once(client, 'end', { signal: AbortSignal.timeout(5000) });
        await close(client);
        await ended;
        await sleep(100);
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        client.disconnect();
      }
    }
  });
});

describe('WORKER role during an outage (e2e, real Redis behind a controllable proxy)', () => {
  const sharedRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const connection = bullConnection(sharedRedisUrl);
  // Scenario-owned keys, separate from local:bull:heartbeat of a running stack.
  const prefix = `e2e-worker-outage-${process.pid}-${Date.now()}`;
  let proxy: RedisProxy | undefined;
  let app: INestApplication | undefined;
  let queue: Queue | undefined;
  let events: QueueEvents | undefined;
  let consoleError: jest.Spied<typeof console.error>;

  beforeAll(async () => {
    consoleError = jest.spyOn(console, 'error');
    proxy = await RedisProxy.reserve(sharedRedisUrl); // reserved, NOT listening
    queue = new Queue(HEARTBEAT_QUEUE, { connection, prefix });
    events = new QueueEvents(HEARTBEAT_QUEUE, { connection, prefix });
    await within(events.waitUntilReady(), 10_000, 'QueueEvents');
  });

  afterAll(async () => {
    await cleanUp(
      () => app?.close(),
      () => proxy?.stop(),
      () => events?.close(),
      () => queue?.close(),
      () => deleteQueueKeys(sharedRedisUrl, prefix),
    ).finally(async () => {
      consoleError.mockRestore();
      await sleep(2100); // ioredis disconnectTimeout, see the first suite
    });
  });

  it('starts while Redis is unreachable, processes jobs after recovery and stops in bounded time', async () => {
    const started = Date.now();
    app = await createApp({ ROLE: 'WORKER', REDIS_URL: proxy!.url }, { queuePrefix: prefix });
    expect(Date.now() - started).toBeLessThan(10_000);

    await proxy!.start();
    const job = await queue!.add(HEARTBEAT_JOB, {});
    await expect(job.waitUntilFinished(events!, 20_000)).resolves.toMatchObject({
      pid: process.pid,
    });
    // The scheduler registered through the same test prefix once Redis came back.
    const deadline = Date.now() + 10_000;
    while (!(await queue!.getJobScheduler(HEARTBEAT_SCHEDULER_ID)) && Date.now() < deadline) {
      await sleep(100);
    }
    expect(await queue!.getJobScheduler(HEARTBEAT_SCHEDULER_ID)).toBeDefined();

    await proxy!.stop();
    await sleep(500);
    const closing = Date.now();
    await app.close();
    app = undefined;
    expect(Date.now() - closing).toBeLessThan(5000);
    // Unhandled queue/worker errors would be printed by BullMQ and may include the Redis address.
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('shutdown while Redis keeps connections open but never answers (e2e)', () => {
  const sharedRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const prefix = `e2e-hung-redis-${process.pid}-${Date.now()}`;
  let proxy: RedisProxy | undefined;
  let app: INestApplication | undefined;

  afterEach(async () => {
    // Proxy first: dropping the sockets fails a QUIT that would otherwise wait forever.
    await cleanUp(
      () => proxy?.stop(),
      () => app?.close(),
    );
    app = undefined;
    proxy = undefined;
  });

  afterAll(async () => {
    await deleteQueueKeys(sharedRedisUrl, prefix);
    await sleep(2100); // ioredis disconnectTimeout, see the first suite
  });

  it.each(['GATEWAY', 'WORKER', 'GATEWAY,WORKER'])(
    'ROLE=%s closes every Redis connection in bounded time',
    async (role) => {
      proxy = await RedisProxy.reserve(sharedRedisUrl);
      await proxy.start();
      app = await createApp({ ROLE: role, REDIS_URL: proxy.url }, { queuePrefix: prefix });
      const queue = app.get<Queue>(getQueueToken(HEARTBEAT_QUEUE));
      await within(queue.waitUntilReady(), 10_000, 'queue');
      if (role.includes('WORKER')) {
        await within(app.get(HeartbeatProcessor).worker.waitUntilReady(), 10_000, 'worker');
      }
      expect(proxy.openClients).toBeGreaterThan(0);

      proxy.freeze(); // QUIT and every other command now wait forever for a reply
      const closing = Date.now();
      await within(app.close(), 8000, 'app.close()');
      app = undefined;
      expect(Date.now() - closing).toBeLessThan(5000);

      // Sockets close asynchronously; ioredis destroys an unanswered one after 2 s at the latest.
      const deadline = Date.now() + 3000;
      while (proxy.openClients > 0 && Date.now() < deadline) await sleep(20);
      expect(proxy.openClients).toBe(0); // the app dropped all its sockets, not only its promises
    },
    20_000,
  );
});
