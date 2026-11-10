# treasury-service

The treasury service of the white-label multi-currency wallet: it consumes completed conversions
(`conversion.completed` Redis Stream), tracks the platform's net currency exposure, and hedges it with a
threshold-based worker (paper execution), keeping hedge history and P&L.

Today this repository is a **skeleton**: a NestJS + GraphQL service with health checks, gateway/worker
process roles with an example BullMQ queue, and the _seams_ (auth, permissions, settings, events) that
let you build features before the real parts exist. The features themselves are your tasks.

## Stack

NestJS 12 · GraphQL (Apollo Server 5, code-first) · Knex + MySQL 8 · Redis (ioredis) · BullMQ · Jest · ESLint + Prettier ·
Node.js 26 (ES modules, TypeScript 6).

## Run locally

Prerequisites: Node.js 26 (`nvm use`), Docker, and the `ops` repository cloned next to this one (`../ops`).
MySQL and Redis come from `ops`; `npm run infra` calls `../ops/dev.sh` from here:

```sh
npm run infra:up              # MySQL (all databases) + Redis only — no application services
npm install
cp .env.example .env          # optional: the defaults match the ops stack
npm run migrate
npm run start:dev
```

Without a `.env` the service still starts: every variable has a local default. That includes `JWT_SECRET`, which
falls back to the **local-only learning secret** `local-only-jwt-secret-change-me-0123456789` (the same value as in
`.env.example`). wallet-core must sign tokens with the same secret, or every request is 401. The fallback applies only
when `NODE_ENV` is not `production`; in production `JWT_SECRET` is required and the service refuses to start without it.

- GraphQL: <http://localhost:3002/graphql> (Apollo Sandbox in the browser)
- Health: <http://localhost:3002/health>

Need another service as well? Run it in Docker next to yours, e.g. `npm run infra -- up wallet-core`
(several names allowed, `all` = the whole system). Containers reach this service at
`http://host.docker.internal:3002`; it reaches them at `localhost:<port>`. Do not start this service in Docker
while you run it from source (same port).

| Script                             | What it does                                                         |
| ---------------------------------- | -------------------------------------------------------------------- |
| `npm run infra:up`                 | `../ops/dev.sh up`: infrastructure only                              |
| `npm run infra -- up <service...>` | Infrastructure + these services in containers (`all` = everything)   |
| `npm run infra:ps` / `infra:down`  | Status / stop the stack (data is kept)                               |
| `npm run infra -- <command>`       | Any `dev.sh` command: `logs <service>`, `build <service>`, `info`, … |

`./dev.sh up` prints the ports and the env values (`DATABASE_URL`, `REDIS_URL`, URLs of the other services). Docker
needs little memory for the infrastructure; images are built one at a time — give Docker at least 4 GiB if you
run the whole stack. Details: the `ops` README.

Every non-public request needs an access token from wallet-core. To try the API locally, sign one yourself with
the local-only secret (it is accepted only while the service runs with that secret):

```sh
TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({ sub: '3c7e1a9b-5d2f-4b8e-9a6c-1f0d2e3b4a5c', permissions: ['wallet'] }, 'local-only-jwt-secret-change-me-0123456789', { issuer: 'wallet-core', expiresIn: '15m' }))")
curl -s localhost:3002/graphql -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d '{"query":"{ me { id permissions } }"}'
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

| Variable       | Default                                                          | Meaning                                                                              |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `PORT`         | `3002`                                                           | HTTP port                                                                            |
| `METRICS_PORT` | `9464`                                                           | Internal port of `GET /metrics` (see [Metrics](#metrics)). Must differ from `PORT`   |
| `METRICS_HOST` | `127.0.0.1` (Docker image: `0.0.0.0`)                            | Address `GET /metrics` listens on                                                    |
| `NODE_ENV`     | `development`                                                    | `production` disables writing `schema.graphql`                                       |
| `APP_ENV`      | `local`                                                          | Environment: `local`, `staging`, `kvitka-uat`, `wisla-uat`. Prefix of all Redis keys |
| `DATABASE_URL` | `mysql://wallet:wallet@localhost:3306/treasury_service`          | MySQL database of this service                                                       |
| `REDIS_URL`    | `redis://localhost:6379`                                         | Redis for events                                                                     |
| `CLIENT`       | `demo`                                                           | Client this deployment serves: `demo`, `kvitka`, `wisla`                             |
| `ROLE`         | `GATEWAY,WORKER`                                                 | Process roles: `GATEWAY`, `WORKER` or both (see below)                               |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:5174`                    | Allowed browser origins                                                              |
| `APP_VERSION`  | from `package.json`                                              | Version reported by `health`                                                         |
| `LOG_LEVEL`    | `info`                                                           | Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`              |
| `JWT_ISSUER`   | `wallet-core`                                                    | Expected issuer of the access tokens                                                 |
| `JWT_SECRET`   | `local-only-jwt-secret-change-me-0123456789` (not in production) | HS256 secret shared with wallet-core. Required when `NODE_ENV=production`            |

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

## Logging

Structured JSON logs via [`nestjs-pino`](https://github.com/iamolegga/nestjs-pino) (`src/logging/`). One line per
event with `time`, `level`, `service`, `appEnv`, `client`, `context` (class) and `msg`; inside an HTTP request, a
GraphQL operation or an event handler also `requestId`. Locally (`npm run start:dev`, `NODE_ENV=development`) the
output is pretty-printed; deployed it is JSON and goes to Grafana (<https://logs.wallet.shatori.com>, see the
handbook's `logging.md`).

```ts
constructor(@InjectPinoLogger(LedgerService.name) private readonly logger: PinoLogger) {}

this.logger.info({ userId, conversionId, amount }, 'conversion booked'); // fields first, then a message
this.logger.error({ err, conversionId }, 'conversion failed'); // pass errors as `err`
```

- **`requestId`**: taken from the incoming `x-request-id` header (or generated) and returned in the response
  header. GraphQL subscriptions get one per websocket connection (`x-request-id` in `connectionParams`).
  `EventPublisher` puts it into the event meta and `EventSubscriber` handlers log with the same id, so one search
  shows a request across services. `POST /diagnostics/ping` (authenticated) publishes `system.ping`, which every
  backend logs — a quick end-to-end trace check.
- **Access log**: one line per HTTP request — method, path, GraphQL operation (`query Me`), status, `durationMs`.
  No bodies, no headers. `/health` probes are logged at `debug`.
- **Secrets are redacted** (`authorization`, `cookie`, `password`, `token`, `secret`, `apiKey`, … at any of the
  first four levels; see `SECRET_KEYS` in `src/logging/logger.options.ts`). Still: never log secrets or whole
  request objects on purpose.
- **`LOG_LEVEL`**: `fatal`, `error`, `warn`, `info` (default), `debug`, `trace`, `silent` (e2e tests default to `silent`).
- Do not use `console.*` or `new Logger()` from `@nestjs/common` in application code.

## Metrics

Prometheus metrics via [`prom-client`](https://github.com/siimon/prom-client) (`src/metrics/`, the same module as in
wallet-core). Alloy scrapes them every 15 s and Grafana shows them on the _Server_ and _Services_ dashboards (see the
handbook's `metrics.md`).

- **Where**: `GET /metrics` on its own small HTTP server on `METRICS_PORT` (default `9464`), not on `PORT`;
  `GET /metrics` on the app port is a 404. If the port is busy, the service starts anyway and logs an error. Running
  several backends from source, give each its own port (`METRICS_PORT=9465 npm run start:dev`).
- **Who can reach it**: run directly on a machine, the server listens on `127.0.0.1` only (`METRICS_HOST`). The
  Docker image sets `METRICS_HOST=0.0.0.0`: the port is not published, so only containers on the same Docker
  network (Alloy, on the server: other apps on `dokploy-network`) reach it, never the internet. Traefik routes the
  public domain to `PORT` only. Metrics carry no ids, amounts or secrets.
- **Labels on every series**: `service` (`treasury-service`) and `env` (`APP_ENV`).
- **Process roles**: `/metrics` runs with every `ROLE`, so a worker-only process is scraped too. Request and
  GraphQL metrics come from the gateway only.

| Metric                          | Type      | Labels              | Meaning                                                                     |
| ------------------------------- | --------- | ------------------- | --------------------------------------------------------------------------- |
| `http_requests_total`           | counter   | `operation, status` | HTTP requests, except `/health`, `/metrics` and CORS preflights             |
| `http_request_duration_seconds` | histogram | `operation`         | Request duration; buckets 5 ms … 10 s                                       |
| `graphql_errors_total`          | counter   | `operation, code`   | Failed GraphQL requests by the error code the client sees (once per code)   |
| `graphql_ws_connections`        | gauge     | —                   | Open GraphQL websocket connections                                          |
| `events_published_total`        | counter   | `type`              | Events published through `EventPublisher`                                   |
| `events_consumed_total`         | counter   | `type`              | Events received through `EventSubscriber`, once per message                 |
| `events_failed_total`           | counter   | `type`              | Received events that failed to decode, or whose handler threw (per handler) |
| `process_*`, `nodejs_*`         | default   | —                   | CPU, memory, heap, event-loop lag, GC, start time (prom-client defaults)    |

- **`operation`**: the operation type and its first root field (`query me`), or the route of a REST request
  (`POST /diagnostics/ping`). The client's own operation name is not used, because any client can invent names and
  every new one would be a new time series. Unparsable GraphQL, requests that matched no route and anything past the
  cap of 100 distinct values go into one bucket, `(unknown)`.
- **Websocket operations**: they add to `graphql_errors_total` but not to `http_requests_total`. Errors raised before
  execution (parse and validation) are all `GRAPHQL_VALIDATION_FAILED` under `(unknown)`; over HTTP a parse error is
  `GRAPHQL_PARSE_FAILED` instead.
- **Adding a metric**: inject `Metrics` and create it once, in the constructor or factory, with bounded labels only:

```ts
constructor(@Inject(Metrics) metrics: Metrics) {
  this.consumed = metrics.counter({
    name: 'events_consumed_total',
    help: 'Events received by this service, by event type',
    labelNames: ['type'],
  });
}

this.consumed.inc({ type: name });
```

- **Label rules**: every distinct label value is a new time series in Prometheus. Never use user ids, request ids,
  amounts, emails or free text as label values; those belong in logs.
- **Check locally**: `curl localhost:9464/metrics`.

## Seams

Seams let you write business logic now and swap the stand-in for the real thing later without touching that logic.

### Auth — `src/auth`

A global `AuthGuard` asks the registered `AuthStrategy` list who the caller is. Every endpoint requires
authentication unless it is marked `@Public()`.

Callers send the access token issued by wallet-core:

```
Authorization: Bearer <access token>
```

`JwtAuthStrategy` verifies it locally, without calling wallet-core: the HS256 signature with `JWT_SECRET` (the same
secret as in wallet-core), the issuer (`JWT_ISSUER`) and the expiry. The user comes from the token: `sub` (UUID) is
`user.id`, the `permissions` claim is `user.permissions`. A missing, invalid or expired token → **401**.

It works for HTTP, GraphQL queries/mutations and GraphQL subscriptions (send `{ "Authorization": "Bearer <token>" }`
as graphql-ws `connectionParams`). The old `Authorization: Dev …` header is no longer accepted.

```ts
@Query(() => Balance)
balance(@CurrentUser() user: AuthUser) { /* user.id, user.permissions */ }

@Public()
@Query(() => PublicSettings)
publicSettings() { ... }
```

**Another way to authenticate** (e.g. service-to-service calls): implement `AuthStrategy`
(`src/auth/auth-strategy.ts`) and register it in `AuthModule` under `AUTH_STRATEGIES`. Business code does not change.

### Permissions — `src/permissions`

```ts
@RequirePermission('bo:users:modify')
@Mutation(() => User)
blockUser(...) { ... }
```

All listed permissions are required (class-level or method-level); missing → **403**. The permissions come
from the `permissions` claim of the access token.

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
| `system.ping`          | Redis pub/sub (diagnostics)     | channel `system.ping`         |

```ts
await publisher.publish('conversion.completed', event); // XADD
const off = await subscriber.subscribe('rate.tick', (tick, meta) => ...); // SUBSCRIBE; meta.requestId
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
  auth/          JWT auth: AuthGuard, JwtAuthStrategy, @CurrentUser, @Public, `me`
  permissions/   @RequirePermission + guard
  settings/      ClientSettingsService (defaults from config/settings.defaults.yaml)
  events/        event catalog + publisher/subscriber
  health/        GET /health and `health` query
  queues/        BullMQ connection    heartbeat/  example queue, processor and scheduler
  config/        env validation + AppConfig
  database/      Knex (KNEX token)    redis/   ioredis (REDIS token)
  graphql/       Apollo options
  metrics/       Prometheus registry, request metrics, GET /metrics on METRICS_PORT
migrations/      Knex migrations (timestamped)
test/            e2e tests
schema.graphql   generated GraphQL contract (committed)
```

One module per feature (`src/exposure/`, `src/hedging/`, …). Shared files (`app.module.ts`, `schema.graphql`)
change in small, dedicated PRs.

## Deployment

Every push to `main` (→ `staging`), `client/kvitka-uat` and `client/wisla-uat` runs `.github/workflows/deploy.yml`,
a thin caller of `ops/.github/workflows/deploy-service.yml`: the image is built in GitHub Actions, pushed to
`ghcr.io/internship-2026-multi-currency-wallet/treasury-service:<env>-<sha>` (and `<env>-latest`), the environment's Dokploy
application is redeployed, and the job waits until `/health` reports the new commit SHA as `version`.
The container runs `npm run migrate && node dist/main.js`, so migrations are applied on every deploy.

| Environment  | Branch              | URL                                                                  | `CLIENT` |
| ------------ | ------------------- | -------------------------------------------------------------------- | -------- |
| `staging`    | `main`              | <https://staging-treasury.wallet.shatori.com/graphql> · `/health`    | `demo`   |
| `kvitka-uat` | `client/kvitka-uat` | <https://kvitka-uat-treasury.wallet.shatori.com/graphql> · `/health` | `kvitka` |
| `wisla-uat`  | `client/wisla-uat`  | <https://wisla-uat-treasury.wallet.shatori.com/graphql> · `/health`  | `wisla`  |

Deployed configuration (set in Dokploy, not in Git): `APP_ENV`, `CLIENT`, `JWT_SECRET` (the same value in
wallet-core, rates-service and treasury-service), `DATABASE_URL` (database
`<env>_treasury_service`), `REDIS_URL`, `CORS_ORIGINS` (`https://<env>.wallet.shatori.com`,
`https://<env>-admin.wallet.shatori.com`), `NODE_OPTIONS`; `APP_VERSION` is baked into the image by CI.
Details: the `ops` README (_Deployment_).

## Docker

```sh
docker build -t treasury-service .
docker run --rm -p 3002:3000 -e DATABASE_URL=... -e REDIS_URL=... treasury-service
```

Multi-stage build on `node:26-alpine`, runs as the non-root `node` user. Run migrations with
`npm run migrate` inside the container (the `ops` compose stack does this on start).
