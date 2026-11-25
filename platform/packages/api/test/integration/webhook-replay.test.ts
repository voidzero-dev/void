import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getRedeliveredGuids, recordWebhookRedelivery } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import type { FailedWebhookDelivery } from '../../src/github/webhook-deliveries.ts';
import { replayFailedWebhookDeliveries } from '../../src/webhook-replay.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

// Drive the mocked deliveries client via module-level mutable state (mirrors the
// `compareStatus` pattern in api-webhooks.test.ts): the factory closures read
// these at call time, so no `vi.hoisted` / TDZ dance is needed.
let failedDeliveries: Array<FailedWebhookDelivery> = [];
// deliveryId -> redeliver result; any id not present defaults to `true`.
let redeliverResults: Record<string, boolean> = {};
const listCalls: Array<{ opts?: { maxPages?: number; perPage?: number } }> = [];
const redeliverCalls: Array<string> = [];

vi.mock('../../src/github/webhook-deliveries.ts', () => ({
  listFailedWebhookDeliveries: async (
    _env: unknown,
    opts?: { maxPages?: number; perPage?: number },
  ) => {
    listCalls.push({ opts });
    return failedDeliveries;
  },
  redeliverWebhookDelivery: async (_env: unknown, deliveryId: string) => {
    redeliverCalls.push(deliveryId);
    return redeliverResults[deliveryId] ?? true;
  },
}));

let env: TestEnv;

// An env with the App secrets present so the App-secret gate opens. The mocked
// deliveries client never reads them, so any non-empty values suffice.
function envWithApp(): ApiEnv['Bindings'] {
  return {
    ...env,
    GITHUB_APP_ID: 'app-id',
    GITHUB_APP_PRIVATE_KEY: 'app-key',
  } as unknown as ApiEnv['Bindings'];
}

// An env with the App secrets absent (dev/unconfigured) so the gate stays shut.
function envWithoutApp(): ApiEnv['Bindings'] {
  return {
    ...env,
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
  } as unknown as ApiEnv['Bindings'];
}

function delivery(
  overrides: Partial<FailedWebhookDelivery> & { id: string },
): FailedWebhookDelivery {
  return {
    guid: `guid-${overrides.id}`,
    event: 'push',
    statusCode: 500,
    deliveredAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  failedDeliveries = [];
  redeliverResults = {};
  listCalls.length = 0;
  redeliverCalls.length = 0;
});

describe('replayFailedWebhookDeliveries()', () => {
  it('redelivers each failed guid once, records it, and returns correct counts', async () => {
    failedDeliveries = [
      delivery({ id: 'del-1', guid: 'g1' }),
      delivery({ id: 'del-2', guid: 'g2' }),
      delivery({ id: 'del-3', guid: 'g3' }),
    ];

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db);

    expect(result).toEqual({ scanned: 3, redelivered: 3 });
    // Redeliver POSTs the numeric delivery id, not the guid.
    expect(redeliverCalls).toEqual(['del-1', 'del-2', 'del-3']);
    // Every guid is now in the ledger.
    const seen = await getRedeliveredGuids(env.db, ['g1', 'g2', 'g3']);
    expect(seen).toEqual(new Set(['g1', 'g2', 'g3']));
    // The list scan is bounded by the page cap.
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].opts?.maxPages).toBe(5);
  });

  it('skips a guid already recorded in the ledger', async () => {
    await recordWebhookRedelivery(env.db, {
      guid: 'g-known',
      deliveryId: 'del-old',
      event: 'push',
      statusCode: 500,
    });

    failedDeliveries = [
      delivery({ id: 'del-known', guid: 'g-known' }),
      delivery({ id: 'del-new', guid: 'g-new' }),
    ];

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db);

    expect(result).toEqual({ scanned: 2, redelivered: 1 });
    // The already-recorded guid is never re-POSTed.
    expect(redeliverCalls).toEqual(['del-new']);
  });

  it('attempts a duplicate guid within the batch only once', async () => {
    // GitHub returns the original + a prior redelivery of the same event; both
    // share the guid, so the in-batch dedup Set collapses them to one attempt.
    failedDeliveries = [
      delivery({ id: 'del-a1', guid: 'g-dup' }),
      delivery({ id: 'del-a2', guid: 'g-dup' }),
    ];

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db);

    expect(result).toEqual({ scanned: 2, redelivered: 1 });
    expect(redeliverCalls).toEqual(['del-a1']);
  });

  it('respects the maxRedeliveries cap', async () => {
    failedDeliveries = [
      delivery({ id: 'del-1', guid: 'g1' }),
      delivery({ id: 'del-2', guid: 'g2' }),
      delivery({ id: 'del-3', guid: 'g3' }),
    ];

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db, {
      maxRedeliveries: 2,
    });

    expect(result).toEqual({ scanned: 3, redelivered: 2 });
    // Stops calling redeliver once the per-run attempt cap is hit.
    expect(redeliverCalls).toEqual(['del-1', 'del-2']);
    const seen = await getRedeliveredGuids(env.db, ['g1', 'g2', 'g3']);
    expect(seen).toEqual(new Set(['g1', 'g2']));
  });

  it('does NOT record a guid when redeliver returns false (so a later run can retry)', async () => {
    failedDeliveries = [delivery({ id: 'del-fail', guid: 'g-fail' })];
    redeliverResults = { 'del-fail': false };

    const result = await replayFailedWebhookDeliveries(envWithApp(), env.db);

    expect(result).toEqual({ scanned: 1, redelivered: 0 });
    expect(redeliverCalls).toEqual(['del-fail']);
    const seen = await getRedeliveredGuids(env.db, ['g-fail']);
    expect(seen.size).toBe(0);
  });

  it('no-ops with no client calls when the App secrets are absent', async () => {
    failedDeliveries = [delivery({ id: 'del-1', guid: 'g1' })];

    const result = await replayFailedWebhookDeliveries(envWithoutApp(), env.db);

    expect(result).toEqual({ scanned: 0, redelivered: 0 });
    expect(listCalls).toHaveLength(0);
    expect(redeliverCalls).toHaveLength(0);
  });
});
