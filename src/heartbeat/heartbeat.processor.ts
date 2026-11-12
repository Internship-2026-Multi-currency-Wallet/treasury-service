import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import type { Job } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { redisErrorReason } from '../redis/redis-connection.js';
import { HEARTBEAT_QUEUE, type HeartbeatResult } from './heartbeat.constants.js';

/**
 * Example BullMQ processor (WORKER role only). Logs a line for every heartbeat job.
 * Real workers (e.g. hedging) follow the same pattern: a queue, a processor, a module.
 */
@Processor(HEARTBEAT_QUEUE)
export class HeartbeatProcessor extends WorkerHost implements BeforeApplicationShutdown {
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

  /**
   * Forced because a graceful close may wait indefinitely while Redis is down; an interrupted job may
   * later be retried as stalled, so processors must stay idempotent.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.close(true);
  }

  /** Without a listener BullMQ prints the raw Redis error, which may contain the host. */
  @OnWorkerEvent('error')
  onError(err: unknown): void {
    this.logger.debug({ reason: redisErrorReason(err) }, 'heartbeat worker error');
  }
}
