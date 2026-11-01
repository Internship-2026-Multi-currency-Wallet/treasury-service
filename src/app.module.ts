import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { type DynamicModule, Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { AuthModule } from './auth/auth.module.js';
import { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { EventsModule } from './events/events.module.js';
import { graphqlOptions } from './graphql/graphql.config.js';
import { HealthModule } from './health/health.module.js';
import { HeartbeatModule } from './heartbeat/heartbeat.module.js';
import { QueuesModule } from './queues/queues.module.js';
import { RedisModule } from './redis/redis.module.js';
import { ClientSettingsModule } from './settings/client-settings.module.js';

/**
 * Root module, composed by process role (`ROLE` env):
 * - shared: config, database, Redis, events, settings, BullMQ queues;
 * - GATEWAY: GraphQL, auth, health endpoints, resolvers;
 * - WORKER: BullMQ processors and schedulers.
 * Shared file: change it only in small, dedicated PRs.
 */
@Module({})
export class AppModule {
  static forRoles(config: Pick<AppConfig, 'isGateway' | 'isWorker'>): DynamicModule {
    const shared = [
      ConfigModule,
      DatabaseModule,
      RedisModule,
      EventsModule,
      ClientSettingsModule,
      QueuesModule,
    ];
    const gateway = config.isGateway
      ? [
          GraphQLModule.forRootAsync<ApolloDriverConfig>({
            driver: ApolloDriver,
            inject: [AppConfig],
            useFactory: graphqlOptions,
          }),
          AuthModule,
          HealthModule,
        ]
      : [];
    const features = [HeartbeatModule.forRoles({ worker: config.isWorker })];
    return { module: AppModule, imports: [...shared, ...gateway, ...features] };
  }
}
