import { jest } from '@jest/globals';
import type { Job } from 'bullmq';
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
});
