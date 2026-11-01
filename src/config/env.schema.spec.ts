import { AppConfig } from './app-config.js';
import { validateEnv } from './env.schema.js';

describe('validateEnv', () => {
  it('applies safe defaults', () => {
    const env = validateEnv({});
    expect(env.CLIENT).toBe('demo');
    expect(env.DEV_AUTH).toBe(false);
    expect(env.PORT).toBe(3002);
  });

  it('parses DEV_AUTH and CLIENT', () => {
    const env = validateEnv({ DEV_AUTH: 'true', CLIENT: 'kvitka', PORT: '4000' });
    expect(env.DEV_AUTH).toBe(true);
    expect(env.CLIENT).toBe('kvitka');
    expect(env.PORT).toBe(4000);
  });

  it('treats empty values as unset', () => {
    expect(validateEnv({ CLIENT: '' }).CLIENT).toBe('demo');
  });

  it('rejects an unknown client with a readable message', () => {
    expect(() => validateEnv({ CLIENT: 'acme' })).toThrow(/CLIENT/);
  });

  it('defaults ROLE to both roles and parses single roles', () => {
    expect(validateEnv({}).ROLE).toEqual(['GATEWAY', 'WORKER']);
    expect(validateEnv({ ROLE: 'worker' }).ROLE).toEqual(['WORKER']);
    expect(validateEnv({ ROLE: ' GATEWAY , GATEWAY ' }).ROLE).toEqual(['GATEWAY']);
  });

  it('rejects unknown roles', () => {
    expect(() => validateEnv({ ROLE: 'GATEWAY,CRON' })).toThrow(/ROLE/);
    expect(() => validateEnv({ ROLE: ',' })).toThrow(/ROLE/);
  });

  it('rejects an invalid DEV_AUTH value', () => {
    expect(() => validateEnv({ DEV_AUTH: 'yes' })).toThrow(/DEV_AUTH/);
  });
});

describe('AppConfig', () => {
  it('exposes the process roles', () => {
    const both = AppConfig.fromEnv({});
    expect([both.isGateway, both.isWorker]).toEqual([true, true]);
    const worker = AppConfig.fromEnv({ ROLE: 'WORKER' });
    expect([worker.isGateway, worker.isWorker]).toEqual([false, true]);
  });

  it('exposes the current client and splits CORS origins', () => {
    const config = AppConfig.fromEnv({ CLIENT: 'wisla', CORS_ORIGINS: 'http://a, http://b' });
    expect(config.client).toBe('wisla');
    expect(config.corsOrigins).toEqual(['http://a', 'http://b']);
  });
});
