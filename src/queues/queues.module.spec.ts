import { bullConnection } from './queues.module.js';

describe('bullConnection', () => {
  it('parses a plain URL', () => {
    expect(bullConnection('redis://localhost:6379')).toMatchObject({
      host: 'localhost',
      port: 6379,
      db: 0,
      maxRetriesPerRequest: null,
    });
  });

  it('parses credentials, db and TLS', () => {
    expect(bullConnection('rediss://user:p%40ss@cache:6380/2')).toMatchObject({
      host: 'cache',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 2,
      tls: {},
    });
  });
});
