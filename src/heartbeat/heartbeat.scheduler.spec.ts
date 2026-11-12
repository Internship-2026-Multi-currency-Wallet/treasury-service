import { jest } from '@jest/globals';
import type { Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { HeartbeatScheduler } from './heartbeat.scheduler.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(upsert: () => Promise<unknown>) {
  const queue = { upsertJobScheduler: jest.fn(upsert) };
  const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const scheduler = new HeartbeatScheduler(
    queue as unknown as Queue,
    logger as unknown as PinoLogger,
  );
  return { queue, logger, scheduler };
}

describe('HeartbeatScheduler', () => {
  it('does not block startup while the scheduler command waits for Redis', async () => {
    let confirm!: (value: unknown) => void;
    const { queue, logger, scheduler } = setup(() => new Promise((resolve) => (confirm = resolve)));

    expect(scheduler.onApplicationBootstrap()).toBeUndefined();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    confirm({});
    await tick();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Heartbeat scheduled'));
  });

  it('logs a safe reason when scheduling fails', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:6379'), {
      code: 'ECONNREFUSED',
    });
    const { logger, scheduler } = setup(() => Promise.reject(error));
    scheduler.onApplicationBootstrap();
    await tick();
    expect(logger.warn).toHaveBeenCalledWith({ reason: 'ECONNREFUSED' }, expect.any(String));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('10.1.2.3');
  });

  it('does not warn when shutdown cancels the pending command', async () => {
    let fail!: (error: unknown) => void;
    const { logger, scheduler } = setup(() => new Promise((_, reject) => (fail = reject)));
    scheduler.onApplicationBootstrap();
    scheduler.onApplicationShutdown();
    fail(new Error('Connection is closed.'));
    await tick();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith({ reason: 'Error' }, expect.any(String));
  });
});
