import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  HEARTBEAT_EVERY_MS,
  HEARTBEAT_JOB,
  HEARTBEAT_QUEUE,
  HEARTBEAT_SCHEDULER_ID,
} from './heartbeat.constants.js';

/**
 * Registers the repeating heartbeat job (every 30 s). `upsertJobScheduler` is idempotent,
 * so several worker processes can call it at start-up without creating duplicates.
 */
@Injectable()
export class HeartbeatScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(HEARTBEAT_QUEUE) private readonly queue: Queue,
    @InjectPinoLogger(HeartbeatScheduler.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      HEARTBEAT_SCHEDULER_ID,
      { every: HEARTBEAT_EVERY_MS },
      { name: HEARTBEAT_JOB, data: {} },
    );
    this.logger.info(`Heartbeat scheduled every ${HEARTBEAT_EVERY_MS / 1000}s`);
  }
}
