import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';

/** Turns `redis://[:password@]host:port[/db]` into BullMQ/ioredis connection options. */
export function bullConnection(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // Required by BullMQ workers (blocking commands).
    maxRetriesPerRequest: null,
  };
}

/**
 * BullMQ connection shared by all queues. Register queues in feature modules with
 * `BullModule.registerQueue({ name })`; put processors in modules loaded only for the WORKER role.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ connection: bullConnection(config.redisUrl) }),
    }),
  ],
})
export class QueuesModule {}
