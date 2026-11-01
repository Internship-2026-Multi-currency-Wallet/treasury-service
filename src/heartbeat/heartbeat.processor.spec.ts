import type { Job } from 'bullmq';
import { HeartbeatProcessor } from './heartbeat.processor.js';

describe('HeartbeatProcessor', () => {
  it('processes a heartbeat job', async () => {
    const result = await new HeartbeatProcessor().process({ id: '1' } as Job);
    expect(result.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(result.processedAt))).toBe(false);
  });
});
