import { afterEach, describe, expect, it } from 'vitest';
import { loadEconomyConfig, loadEventMasterConfig } from './config.js';

const keys = [
  'DATABASE_URL',
  'ECONOMY_BOT_TOKEN',
  'ECONOMY_CLIENT_ID',
  'EVENT_MASTER_BOT_TOKEN',
  'EVENT_MASTER_CLIENT_ID',
] as const;
const previous = new Map(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('bot configuration isolation', () => {
  it('loads Economy Bot settings without requiring Event Master credentials', () => {
    process.env.DATABASE_URL = 'postgresql://local:local@localhost:5432/bots';
    process.env.ECONOMY_BOT_TOKEN = 'local-test-token';
    process.env.ECONOMY_CLIENT_ID = '12345';
    delete process.env.EVENT_MASTER_BOT_TOKEN;
    delete process.env.EVENT_MASTER_CLIENT_ID;

    expect(loadEconomyConfig().ECONOMY_CLIENT_ID).toBe('12345');
  });

  it('loads Event Master settings without requiring Economy Bot credentials', () => {
    process.env.DATABASE_URL = 'postgresql://local:local@localhost:5432/bots';
    process.env.EVENT_MASTER_BOT_TOKEN = 'local-test-token';
    process.env.EVENT_MASTER_CLIENT_ID = '67890';
    delete process.env.ECONOMY_BOT_TOKEN;
    delete process.env.ECONOMY_CLIENT_ID;

    expect(loadEventMasterConfig().EVENT_MASTER_CLIENT_ID).toBe('67890');
  });

  it('reports missing credentials without including secret values', () => {
    process.env.DATABASE_URL = 'postgresql://local:local@localhost:5432/bots';
    process.env.ECONOMY_CLIENT_ID = '12345';
    delete process.env.ECONOMY_BOT_TOKEN;

    expect(() => loadEconomyConfig()).toThrow('ECONOMY_BOT_TOKEN');
  });
});
