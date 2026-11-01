# treasury-service

The treasury service of the white-label multi-currency wallet: it consumes completed conversions
(`conversion.completed` Redis Stream), tracks the platform's net currency exposure, and hedges it with a
threshold-based worker (paper execution), keeping hedge history and P&L.

Today this repository is a **skeleton**: a NestJS + GraphQL service with health checks, gateway/worker
process roles with an example BullMQ queue, and the _seams_ (dev auth, permissions, settings, events) that
let you build features before the real parts exist. The features themselves are your tasks.

## Stack

NestJS 12 · GraphQL (Apollo Server 5, code-first) · Knex + MySQL 8 · Redis (ioredis) · BullMQ · Jest · ESLint + Prettier ·
Node.js 26 (ES modules, TypeScript 6).

## Run locally

Prerequisites: Node.js 26 (`nvm use`), Docker. MySQL and Redis come from the `ops` repository:

```sh
# in ../ops — start only the databases
docker compose up -d mysql redis

# here
npm install
cp .env.example .env          # optional: the defaults match the compose stack
npm run migrate
DEV_AUTH=true npm run start:dev
```

- GraphQL: <http://localhost:3002/graphql> (Apollo Sandbox in the browser)
- Health: <http://localhost:3002/health>

To run the whole system (all services + frontends), see the `ops` repository README.

```sh
curl -s localhost:3002/graphql -H 'content-type: application/json' \
  -H 'Authorization: Dev 1:wallet' -d '{"query":"{ me { id permissions } }"}'
```

## Scripts

| Script                                        | What it does                                                          |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `npm run start:dev`                           | Start with watch mode (also regenerates `schema.graphql`)             |
| `npm run build` / `npm run start:prod`        | Compile to `dist/` / run the compiled app                             |
| `npm run lint` / `npm run format`             | ESLint (type-aware) / Prettier                                        |
| `npm run typecheck`                           | `tsc --noEmit` over sources, tests and scripts                        |
| `npm test`                                    | Unit tests (`src/**/*.spec.ts`), no database needed                   |
| `npm run test:e2e`                            | End-to-end tests (`test/*.e2e-spec.ts`) against real MySQL + Redis    |
| `npm run test:cov`                            | Unit tests with coverage                                              |
| `npm run schema:generate`                     | Write `schema.graphql` from the resolvers without starting the server |
| `npm run migrate`                             | Apply pending Knex migrations                                         |
| `npm run migrate:make -- <name>`              | Create `migrations/<timestamp>_<name>.ts`                             |
| `npm run migrate:rollback` / `migrate:status` | Roll back the last batch / list migrations                            |

## Environment variables

Validated at startup (`src/config/env.schema.ts`); an invalid value stops the service with a clear message.
See `.env.example`.

| Variable                       | Default                                                 | Meaning                                                                                              |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`                         | `3002`                                                  | HTTP port                                                                                            |
| `NODE_ENV`                     | `development`                                           | `production` disables writing `schema.graphql`                                                       |
| `APP_ENV`                      | `local`                                                 | Environment: `local`, `staging`, `kvitka-uat`, `wisla-uat`. Prefix of all Redis keys                 |
| `DATABASE_URL`                 | `mysql://wallet:wallet@localhost:3306/treasury_service` | MySQL database of this service                                                                       |
| `REDIS_URL`                    | `redis://localhost:6379`                                | Redis for events                                                                                     |
| `CLIENT`                       | `demo`                                                  | Client this deployment serves: `demo`, `kvitka`, `wisla`                                             |
| `ROLE`                         | `GATEWAY,WORKER`                                        | Process roles: `GATEWAY`, `WORKER` or both (see below)                                               |
| `DEV_AUTH`                     | `false`                                                 | Accept `Authorization: Dev …` headers (see below). Refused at startup when `APP_ENV` is a client UAT |
| `CORS_ORIGINS`                 | `http://localhost:5173,http://localhost:5174`           | Allowed browser origins                                                                              |
| `APP_VERSION`                  | from `package.json`                                     | Version reported by `health`                                                                         |
| `JWT_ISSUER`, `JWT_PUBLIC_KEY` | —                                                       | Placeholders: tokens are issued by wallet-core, this service will only verify them (not used yet)    |

## Process roles: gateway and worker

One image, started with different `ROLE`s:

| `ROLE`                     | What runs                                                          |
| -------------------------- | ------------------------------------------------------------------ |
| `GATEWAY`                  | HTTP server: GraphQL, `GET /health`, auth guards. Can enqueue jobs |
| `WORKER`                   | BullMQ processors and job schedulers. No HTTP server               |
| `GATEWAY,WORKER` (default) | Both in one process — convenient locally                           |

In deployed environments the gateway and the worker run as separate containers, so slow background work never
blocks API requests and each part scales on its own. `AppModule.forRoles()` composes the modules per role.

BullMQ keys are prefixed with the environment too (`<APP_ENV>:bull:<queue>:…`, see `bullPrefix`).

**Example queue** (`src/heartbeat/`): the worker registers a job scheduler that adds a `heartbeat` job every 30 s;
`HeartbeatProcessor` logs a line for each job. New background work follows the same pattern:

1. a queue name + `BullModule.registerQueue({ name })` in the feature module (available in every role);
2. a processor (`@Processor(name)` extending `WorkerHost`) provided **only** when `worker` is true;
3. unit tests for the processor logic and an e2e test against Redis (see `test/worker.e2e-spec.ts`).

```sh
ROLE=WORKER npm run start:dev    # worker only
ROLE=GATEWAY npm run start:dev   # API only
```

## GraphQL contract

The schema is **code-first**: resolvers and `@ObjectType`s are the source of truth, and the generated
`schema.graphql` at the repository root is **committed**. It is the contract other repositories
(`back-office`, other services) build against — the frontends download it from `main`.

- `npm run start:dev` and the e2e tests regenerate it; `npm run schema:generate` does it without a database.
- A PR that changes the API must include the regenerated `schema.graphql`. That diff is what consumers review.

Current API: `health { service version appEnv client db redis }` (public) and `me { id permissions strategy }`.

## Seams

Seams let you write business logic now and swap the stand-in for the real thing later without touching that logic.

### Dev auth — `src/auth`

A global `AuthGuard` asks the registered `AuthStrategy` list who the caller is. Every endpoint requires
authentication unless it is marked `@Public()`.

With `DEV_AUTH=true` the `DevAuthStrategy` accepts:

```
Authorization: Dev <userId>:<perm1,perm2>
Authorization: Dev 1:wallet
Authorization: Dev 100:bo:users,bo:users:modify
```

It works for HTTP, GraphQL queries/mutations and GraphQL subscriptions (send `{ "Authorization": "Dev 1:wallet" }`
as graphql-ws `connectionParams`). With `DEV_AUTH=false` and no real strategy registered, every non-public request is **401**.

`DEV_AUTH=true` is allowed only with `APP_ENV=local` or `staging`; in a client UAT (`*-uat`) the service refuses to start.

```ts
@Query(() => Balance)
balance(@CurrentUser() user: AuthUser) { /* user.id, user.permissions */ }

@Public()
@Query(() => PublicSettings)
publicSettings() { ... }
```

**Adding real auth later:** implement `AuthStrategy` (`src/auth/auth-strategy.ts`) that verifies wallet-core's JWT
with the public key (no call to wallet-core), register it in `AuthModule` under `AUTH_STRATEGIES`. Nothing else changes.

### Permissions — `src/permissions`

```ts
@RequirePermission('bo:users:modify')
@Mutation(() => User)
blockUser(...) { ... }
```

All listed permissions are required (class-level or method-level); missing → **403**. In dev mode you choose the
permissions in the header, e.g. `Dev 100:bo:users,bo:users:modify`.

### Client settings — `src/settings`

```ts
const phone = await settings.get('auth.phoneRequiredAt'); // 'signup' | 'firstTransfer' | 'never'
const google = await settings.get('auth.googleLogin'); // boolean
```

`ClientSettingsService.get(key)` is typed by the catalog in `src/settings/settings.schema.ts`. **Defaults live in
the code** (`config/settings.defaults.yaml`, validated at startup), so a fresh environment works with an empty database.
The real settings store is a later task: it keeps **only overrides** in this service's database (one environment =
one client = one database) and falls back to these defaults. Callers do not change.

To add a setting: declare it in `settings.schema.ts` and give it a default in `settings.defaults.yaml`.

### Current client — `AppConfig`

`AppConfig.client` is the `CLIENT` this deployment serves. Inject `AppConfig` instead of reading `process.env`.
The client customization module (hooks, client-only endpoints) is a separate task.

### Events — `src/events`

`catalog.ts` is the typed contract for Redis events, **identical in all three backends**:

| Event                  | Transport                       | Name                          |
| ---------------------- | ------------------------------- | ----------------------------- |
| `rate.tick`            | Redis pub/sub (fire-and-forget) | channel `rate.tick`           |
| `conversion.completed` | Redis Stream (must not be lost) | stream `conversion.completed` |

```ts
await publisher.publish('conversion.completed', event); // XADD
const off = await subscriber.subscribe('rate.tick', (tick) => ...); // SUBSCRIBE
```

Stream consumers use consumer groups (`XREADGROUP` + `XACK`) and `decodeStreamEntry()` — the
`conversion.completed` consumer of this service is a task. Consumers must be idempotent (use `eventId`).
Change the catalog only via a contract PR in all three repositories.

**Environment prefix.** Several environments may share one Redis, so every channel and stream is prefixed with
`APP_ENV`: `staging:rate.tick`, `kvitka-uat:conversion.completed`. The helpers add the prefix; when you need a raw
name (e.g. a stream consumer) use `eventStream(appConfig.appEnv, 'conversion.completed')` / `eventChannel(...)`.

## Project layout

```
src/
  auth/          dev auth seam: AuthGuard, AuthStrategy, @CurrentUser, @Public, `me`
  permissions/   @RequirePermission + guard
  settings/      ClientSettingsService (defaults from config/settings.defaults.yaml)
  events/        event catalog + publisher/subscriber
  health/        GET /health and `health` query
  queues/        BullMQ connection    heartbeat/  example queue, processor and scheduler
  config/        env validation + AppConfig
  database/      Knex (KNEX token)    redis/   ioredis (REDIS token)
  graphql/       Apollo options
migrations/      Knex migrations (timestamped)
test/            e2e tests
schema.graphql   generated GraphQL contract (committed)
```

One module per feature (`src/exposure/`, `src/hedging/`, …). Shared files (`app.module.ts`, `schema.graphql`)
change in small, dedicated PRs.

## Docker

```sh
docker build -t treasury-service .
docker run --rm -p 3002:3000 -e DATABASE_URL=... -e REDIS_URL=... treasury-service
```

Multi-stage build on `node:26-alpine`, runs as the non-root `node` user. Run migrations with
`npm run migrate` inside the container (the `ops` compose stack does this on start).
