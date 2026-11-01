import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { HEARTBEAT_QUEUE, type HeartbeatResult } from './heartbeat.constants.js';

/**
 * Example BullMQ processor (WORKER role only). Logs a line for every heartbeat job.
 * Real workers (e.g. hedging) follow the same pattern: a queue, a processor, a module.
 */
@Processor(HEARTBEAT_QUEUE)
export class HeartbeatProcessor extends WorkerHost {
  private readonly logger = new Logger(HeartbeatProcessor.name);

  process(job: Job): Promise<HeartbeatResult> {
    const result: HeartbeatResult = { processedAt: new Date().toISOString(), pid: process.pid };
    this.logger.log(`Heartbeat job ${job.id ?? '?'} processed by pid ${result.pid}`);
    return Promise.resolve(result);
  }
}
