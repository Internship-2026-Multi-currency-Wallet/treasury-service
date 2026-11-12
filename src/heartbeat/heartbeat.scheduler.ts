import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { redisErrorReason } from '../redis/redis-connection.js';
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
export class HeartbeatScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private closing = false;

  constructor(
    @InjectQueue(HEARTBEAT_QUEUE) private readonly queue: Queue,
    @InjectPinoLogger(HeartbeatScheduler.name) private readonly logger: PinoLogger,
  ) {}

  /** Not awaited: BullMQ queues the command until Redis is reachable, which must not block startup. */
  onApplicationBootstrap(): void {
    this.queue
      .upsertJobScheduler(
        HEARTBEAT_SCHEDULER_ID,
        { every: HEARTBEAT_EVERY_MS },
        { name: HEARTBEAT_JOB, data: {} },
      )
      .then(
        () => this.logger.info(`Heartbeat scheduled every ${HEARTBEAT_EVERY_MS / 1000}s`),
        (err: unknown) => {
          const fields = { reason: redisErrorReason(err) };
          if (this.closing) this.logger.debug(fields, 'heartbeat scheduling cancelled');
          else this.logger.warn(fields, 'heartbeat scheduling failed');
        },
      );
  }

  onApplicationShutdown(): void {
    this.closing = true;
  }
}
