import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { HEARTBEAT_QUEUE, type HeartbeatResult } from './heartbeat.constants.js';

/**
 * Example BullMQ processor (WORKER role only). Logs a line for every heartbeat job.
 * Real workers (e.g. hedging) follow the same pattern: a queue, a processor, a module.
 */
@Processor(HEARTBEAT_QUEUE)
export class HeartbeatProcessor extends WorkerHost {
  constructor(@InjectPinoLogger(HeartbeatProcessor.name) private readonly logger: PinoLogger) {
    super();
  }

  process(job: Job): Promise<HeartbeatResult> {
    const result: HeartbeatResult = { processedAt: new Date().toISOString(), pid: process.pid };
    this.logger.info(
      { jobId: job.id, pid: result.pid },
      `Heartbeat job ${job.id ?? '?'} processed by pid ${result.pid}`,
    );
    return Promise.resolve(result);
  }
}
