import { jest } from '@jest/globals';
import type { Job, Worker } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { HeartbeatProcessor } from './heartbeat.processor.js';

describe('HeartbeatProcessor', () => {
  it('processes a heartbeat job and logs it', async () => {
    const logger = { info: jest.fn() };
    const result = await new HeartbeatProcessor(logger as unknown as PinoLogger).process({
      id: '1',
    } as Job);
    expect(result.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(result.processedAt))).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      { jobId: '1', pid: process.pid },
      expect.stringContaining('Heartbeat job 1'),
    );
  });

  it('force-closes the worker on shutdown so a Redis outage cannot block it', async () => {
    const processor = new HeartbeatProcessor({} as unknown as PinoLogger);
    const close = jest.fn(() => Promise.resolve());
    jest.spyOn(processor, 'worker', 'get').mockReturnValue({ close } as unknown as Worker);
    await processor.beforeApplicationShutdown();
    expect(close).toHaveBeenCalledWith(true);
  });

  it('logs worker errors with a safe reason only', () => {
    const logger = { debug: jest.fn() };
    new HeartbeatProcessor(logger as unknown as PinoLogger).onError(
      Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:6379'), { code: 'ECONNREFUSED' }),
    );
    expect(logger.debug).toHaveBeenCalledWith({ reason: 'ECONNREFUSED' }, expect.any(String));
  });
});
