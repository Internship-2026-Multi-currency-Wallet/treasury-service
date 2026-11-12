import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { type DynamicModule, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { bullConnection } from '../queues/queues.module.js';
import { closeRedis, redisErrorReason } from '../redis/redis-connection.js';
import { HEARTBEAT_QUEUE } from './heartbeat.constants.js';
import { HeartbeatProcessor } from './heartbeat.processor.js';
import { HeartbeatScheduler } from './heartbeat.scheduler.js';

/**
 * Example queue. The queue itself is available in every role (a gateway can enqueue jobs);
 * the processor and the scheduler run only in the WORKER role.
 */
@Module({})
export class HeartbeatModule implements OnApplicationShutdown {
  private readonly connection: Redis;

  constructor(
    @InjectQueue(HEARTBEAT_QUEUE) queue: Queue,
    @InjectPinoLogger(HeartbeatModule.name) logger: PinoLogger,
  ) {
    this.connection = queue.opts.connection as Redis;
    // Without a listener BullMQ prints the raw Redis error, which may contain the host.
    queue.on('error', (err) =>
      logger.debug({ reason: redisErrorReason(err) }, 'heartbeat queue error'),
    );
    // Reported through the queue; keeps ioredis quiet once BullMQ has detached its listener.
    this.connection.on('error', () => undefined);
  }

  /** The supplied client is ours to close; bound QUIT because Redis may stop answering. */
  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.connection);
  }

  static forRoles({ worker }: { worker: boolean }): DynamicModule {
    return {
      module: HeartbeatModule,
      imports: [
        BullModule.registerQueueAsync({
          name: HEARTBEAT_QUEUE,
          inject: [AppConfig],
          // The worker shares this client for regular commands and duplicates it for blocking ones.
          useFactory: (config: AppConfig) => ({
            connection: new Redis(bullConnection(config.redisUrl)),
          }),
        }),
      ],
      providers: worker ? [HeartbeatProcessor, HeartbeatScheduler] : [],
      exports: [BullModule],
    };
  }
}
