import { GraphQLModule } from '@nestjs/graphql';
import { AuthModule } from './auth/auth.module.js';
import { AppModule } from './app.module.js';
import { HeartbeatProcessor } from './heartbeat/heartbeat.processor.js';
import { HealthModule } from './health/health.module.js';
import { ThrottlingModule } from './throttling/throttling.module.js';

describe('AppModule.forRoles', () => {
  const imports = (isGateway: boolean, isWorker: boolean) =>
    AppModule.forRoles({ isGateway, isWorker }).imports ?? [];
  const hasGraphQL = (list: unknown[]) =>
    list.some((m) => (m as { module?: unknown }).module === GraphQLModule);
  const heartbeatProviders = (list: unknown[]) =>
    (list.at(-1) as { providers: unknown[] }).providers;

  it('GATEWAY serves GraphQL and HTTP but runs no processors', () => {
    const list = imports(true, false);
    expect(hasGraphQL(list)).toBe(true);
    expect(list).toEqual(expect.arrayContaining([AuthModule, HealthModule, ThrottlingModule]));
    expect(heartbeatProviders(list)).not.toContain(HeartbeatProcessor);
  });

  it('WORKER runs processors and serves nothing', () => {
    const list = imports(false, true);
    expect(hasGraphQL(list)).toBe(false);
    expect(list).not.toContain(AuthModule);
    expect(list).not.toContain(ThrottlingModule);
    expect(heartbeatProviders(list)).toContain(HeartbeatProcessor);
  });

  it('GATEWAY,WORKER does both', () => {
    const list = imports(true, true);
    expect(hasGraphQL(list)).toBe(true);
    expect(list).toContain(ThrottlingModule);
    expect(heartbeatProviders(list)).toContain(HeartbeatProcessor);
  });
});
