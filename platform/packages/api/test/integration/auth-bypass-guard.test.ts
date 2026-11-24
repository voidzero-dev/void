import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import app from '../../src/index.ts';
import { setupEnv, teardownEnv, clearTables, createTestUser } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DEV_AUTH_BYPASS production guard', () => {
  it('ignores DEV_AUTH_BYPASS when PLATFORM_ENV is production', async () => {
    await createTestUser(env.db, 'bypass-user');

    const res = await app.fetch(new Request('http://localhost/me'), {
      ...env,
      DEV_AUTH_BYPASS: 'true',
      PLATFORM_ENV: 'production',
    });
    expect(res.status).toBe(401);
  });

  it('allows DEV_AUTH_BYPASS when PLATFORM_ENV is not production', async () => {
    await createTestUser(env.db, 'bypass-user');

    const res = await app.fetch(new Request('http://localhost/me'), {
      ...env,
      DEV_AUTH_BYPASS: 'true',
    });
    expect(res.status).toBe(200);
  });

  it('ignores DEV_AUTH_BYPASS when value is not the exact string "true"', async () => {
    await createTestUser(env.db, 'bypass-user');

    for (const value of ['false', '0', 'TRUE', '1']) {
      const res = await app.fetch(new Request('http://localhost/me'), {
        ...env,
        DEV_AUTH_BYPASS: value,
      });
      expect(res.status, `DEV_AUTH_BYPASS=${value}`).toBe(401);
    }
  });
});
