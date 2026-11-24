import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  acquireSandboxDrainLease,
  completeSandboxDrain,
  readSandboxDrainCheckpoint,
} from '../../src/sandbox-drain.ts';
import { sandboxDrainCheckpoints } from '../../src/schema.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
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
  await env.db.delete(sandboxDrainCheckpoints);
});

describe('Sandbox drain checkpoint fencing', () => {
  it('returns busy while another page owns the lease', async () => {
    const first = await acquireSandboxDrainLease(env.db);
    expect(first.kind).toBe('acquired');
    const second = await acquireSandboxDrainLease(env.db);
    expect(second.kind).toBe('busy');
  });

  it('rejects stale completion after a newer worker takes an expired lease', async () => {
    const first = await acquireSandboxDrainLease(env.db);
    if (first.kind !== 'acquired') {
      throw new Error('expected first lease');
    }
    await env.db
      .update(sandboxDrainCheckpoints)
      .set({ lease_expires_at: '2000-01-01T00:00:00.000Z' })
      .where(eq(sandboxDrainCheckpoints.singleton, true));
    const second = await acquireSandboxDrainLease(env.db);
    if (second.kind !== 'acquired') {
      throw new Error('expected replacement lease');
    }

    await expect(
      completeSandboxDrain(env.db, {
        generation: first.checkpoint.generation,
        owner: first.owner,
      }),
    ).rejects.toThrow(/stale work cannot complete/i);
    expect((await readSandboxDrainCheckpoint(env.db))?.state).toBe('draining');

    await completeSandboxDrain(env.db, {
      generation: second.checkpoint.generation,
      owner: second.owner,
    });
    expect((await readSandboxDrainCheckpoint(env.db))?.state).toBe('complete');
  });
});
