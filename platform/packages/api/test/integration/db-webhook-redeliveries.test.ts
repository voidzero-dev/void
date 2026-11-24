import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { getRedeliveredGuids, recordWebhookRedelivery } from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import { githubWebhookRedeliveries } from '../../src/schema.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

// The ledger is standalone (no FKs), so a plain delete before the shared
// clearTables keeps rows from leaking across files under the real-Postgres run.
async function clearLedger(db: Db): Promise<void> {
  await db.delete(githubWebhookRedeliveries);
}

beforeEach(async () => {
  await clearLedger(env.db);
  await clearTables(env.db);
});

describe('github_webhook_redeliveries — replay ledger', () => {
  it('recordWebhookRedelivery then getRedeliveredGuids([guid]) returns a Set containing it', async () => {
    await recordWebhookRedelivery(env.db, {
      guid: 'guid-1',
      deliveryId: '111',
      event: 'push',
      statusCode: 500,
    });

    const seen = await getRedeliveredGuids(env.db, ['guid-1']);
    expect(seen.has('guid-1')).toBe(true);
    expect(seen.size).toBe(1);

    // The row round-trips with a ghwr_ id and the audit columns intact.
    const rows = await env.db.select().from(githubWebhookRedeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0].id.startsWith('ghwr_')).toBe(true);
    expect(rows[0].guid).toBe('guid-1');
    expect(rows[0].delivery_id).toBe('111');
    expect(rows[0].event).toBe('push');
    expect(rows[0].status_code).toBe(500);
    expect(rows[0].redelivered_at).not.toBeNull();
  });

  it('double recordWebhookRedelivery with the same guid → exactly one row (onConflictDoNothing)', async () => {
    await recordWebhookRedelivery(env.db, {
      guid: 'guid-dup',
      deliveryId: '111',
      event: 'push',
      statusCode: 500,
    });
    // A second record for the SAME guid (a different delivery id / null audit
    // fields) must be absorbed by the unique index without throwing.
    await recordWebhookRedelivery(env.db, {
      guid: 'guid-dup',
      deliveryId: '222',
      event: null,
      statusCode: null,
    });

    const rows = await env.db.select().from(githubWebhookRedeliveries);
    expect(rows).toHaveLength(1);
    // The first insert wins (onConflictDoNothing keeps the existing row).
    expect(rows[0].delivery_id).toBe('111');
  });

  it('getRedeliveredGuids([]) → empty Set, no query error', async () => {
    const seen = await getRedeliveredGuids(env.db, []);
    expect(seen.size).toBe(0);
  });

  it('getRedeliveredGuids returns only the recorded subset for a mix of known + unknown guids', async () => {
    await recordWebhookRedelivery(env.db, {
      guid: 'known-a',
      deliveryId: '1',
      event: 'push',
      statusCode: 502,
    });
    await recordWebhookRedelivery(env.db, {
      guid: 'known-b',
      deliveryId: '2',
      event: 'pull_request',
      statusCode: null,
    });

    const seen = await getRedeliveredGuids(env.db, [
      'known-a',
      'unknown-x',
      'known-b',
      'unknown-y',
    ]);
    expect(seen).toEqual(new Set(['known-a', 'known-b']));
  });
});
