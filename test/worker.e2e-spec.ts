import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue, QueueEvents } from 'bullmq';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.js';
import {
  HEARTBEAT_EVERY_MS,
  HEARTBEAT_JOB,
  HEARTBEAT_QUEUE,
  HEARTBEAT_SCHEDULER_ID,
  type HeartbeatResult,
} from '../src/heartbeat/heartbeat.constants.js';
import { bullConnection } from '../src/queues/queues.module.js';

describe('WORKER role (e2e, real Redis)', () => {
  const connection = bullConnection(process.env.REDIS_URL ?? 'redis://localhost:6379');
  let app: INestApplicationContext;
  let queue: Queue;
  let events: QueueEvents;

  beforeAll(async () => {
    const config = AppConfig.fromEnv({ ...process.env, ROLE: 'WORKER' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoles(config)] })
      .overrideProvider(AppConfig)
      .useValue(config)
      .compile();
    app = await moduleRef.init();
    queue = new Queue(HEARTBEAT_QUEUE, { connection });
    events = new QueueEvents(HEARTBEAT_QUEUE, { connection });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await events.close();
    await queue.close();
    await app.close();
  });

  it('registers the heartbeat scheduler (every 30 s)', async () => {
    const scheduler = await queue.getJobScheduler(HEARTBEAT_SCHEDULER_ID);
    expect(scheduler).toMatchObject({ every: HEARTBEAT_EVERY_MS, name: HEARTBEAT_JOB });
  });

  it('processes heartbeat jobs', async () => {
    const job = await queue.add(HEARTBEAT_JOB, {});
    const result = (await job.waitUntilFinished(events, 10_000)) as HeartbeatResult;
    // Any worker on this Redis may take the job (e.g. a running compose stack), so check the shape only.
    expect(Number.isNaN(Date.parse(result.processedAt))).toBe(false);
    expect(result.pid).toEqual(expect.any(Number));
  });
});
