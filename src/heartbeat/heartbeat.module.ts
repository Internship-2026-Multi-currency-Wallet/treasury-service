import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { HEARTBEAT_QUEUE } from './heartbeat.constants.js';
import { HeartbeatProcessor } from './heartbeat.processor.js';
import { HeartbeatScheduler } from './heartbeat.scheduler.js';

/**
 * Example queue. The queue itself is available in every role (a gateway can enqueue jobs);
 * the processor and the scheduler run only in the WORKER role.
 */
@Module({})
export class HeartbeatModule {
  static forRoles({ worker }: { worker: boolean }): DynamicModule {
    return {
      module: HeartbeatModule,
      imports: [BullModule.registerQueue({ name: HEARTBEAT_QUEUE })],
      providers: worker ? [HeartbeatProcessor, HeartbeatScheduler] : [],
      exports: [BullModule],
    };
  }
}
