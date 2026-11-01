import { z } from 'zod';
import { LOG_LEVELS } from '../logging/logger.options.js';

/** Clients this codebase knows about. Each deployment serves exactly one of them. */
export const KNOWN_CLIENTS = ['demo', 'kvitka', 'wisla'] as const;
export type ClientCode = (typeof KNOWN_CLIENTS)[number];

/**
 * Process roles. One image, started with different `ROLE`s:
 * - `GATEWAY` serves HTTP and GraphQL;
 * - `WORKER` runs BullMQ processors (background jobs).
 */
export const PROCESS_ROLES = ['GATEWAY', 'WORKER'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

const rolesFromString = z
  .string()
  .default('GATEWAY,WORKER')
  .transform((value, ctx): ProcessRole[] => {
    const roles = [...new Set(value.split(',').map((role) => role.trim().toUpperCase()))].filter(
      Boolean,
    );
    const invalid = roles.filter((role) => !(PROCESS_ROLES as readonly string[]).includes(role));
    if (roles.length === 0 || invalid.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Expected GATEWAY, WORKER or GATEWAY,WORKER, got "${value}"`,
      });
      return z.NEVER;
    }
    return roles as ProcessRole[];
  });

/**
 * Environment this deployment belongs to. Prefixes all Redis keys (`kvitka-uat:rate.tick`),
 * so several environments can share one Redis.
 */
export const APP_ENVS = ['local', 'staging', 'kvitka-uat', 'wisla-uat'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Dev auth is allowed only outside client UAT environments. */
export function isDevAuthAllowed(appEnv: AppEnv): boolean {
  return !appEnv.endsWith('-uat');
}

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

/**
 * Environment variables of the service. Validated once at startup:
 * a missing or invalid value stops the process with a clear message.
 * Keep `.env.example` in sync with this schema.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ENV: z.enum(APP_ENVS).default('local'),
    PORT: z.coerce.number().int().positive().default(3002),
    DATABASE_URL: z.url().default('mysql://wallet:wallet@localhost:3306/treasury_service'),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    CLIENT: z.enum(KNOWN_CLIENTS).default('demo'),
    DEV_AUTH: booleanFromString,
    ROLE: rolesFromString,
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
    APP_VERSION: z.string().optional(),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    // Placeholders for the real JWT strategy (not used yet).
    JWT_ISSUER: z.string().default('wallet-core'),
    JWT_PUBLIC_KEY: z.string().optional(),
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),
  })
  .superRefine((env, ctx) => {
    if (env.DEV_AUTH && !isDevAuthAllowed(env.APP_ENV)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_AUTH'],
        message: `DEV_AUTH=true is not allowed in client environment "${env.APP_ENV}" (only local and staging)`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: NodeJS.ProcessEnv): Env {
  // Treat empty strings as "not set", so `FOO=` in .env falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
