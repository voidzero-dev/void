import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { securityScans } from '../../src/schema.ts';
import {
  fillSecurityGatewayCosts,
  queryAiGatewayTagCost,
  SECURITY_GATEWAY_COST_BATCH,
} from '../../src/security/gateway-cost.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const HOUR = 60 * 60_000;

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
});

async function project() {
  const user = await createTestUser(env.db, `gateway-cost-${crypto.randomUUID()}`);
  const created = await createTestProject(env.db, user.id);
  const deployment = await createTestDeployment(env.db, created.id, 'live');
  return { projectId: created.id, deploymentId: deployment.id };
}

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

async function costs() {
  return Object.fromEntries(
    (
      await env.db
        .select({ id: securityScans.id, cost: securityScans.cost_nano_usd })
        .from(securityScans)
        .orderBy(asc(securityScans.id))
    ).map((row) => [row.id, row.cost]),
  );
}

describe('gateway cost of ended scans (spec §16)', () => {
  it('fills ended scans 1 h to 7 d old, by their signed tag and time window', async () => {
    const { projectId, deploymentId } = await project();
    const base = { project_id: projectId, deployment_id: deploymentId, trigger: 'deploy' as const };
    await env.db.insert(securityScans).values([
      {
        ...base,
        id: 'ss_due',
        status: 'succeeded',
        model_calls: 12,
        first_queued_at: ago(3 * HOUR),
        started_at: ago(2.5 * HOUR),
        finished_at: ago(2 * HOUR),
      },
      // No model call: zero, and no query.
      { ...base, id: 'ss_none', status: 'skipped', model_calls: 0, finished_at: ago(2 * HOUR) },
      // Too young: the gateway data may not be in yet.
      { ...base, id: 'ss_young', status: 'failed', model_calls: 3, finished_at: ago(HOUR / 2) },
      // Too old: stays unknown.
      { ...base, id: 'ss_old', status: 'failed', model_calls: 3, finished_at: ago(8 * 24 * HOUR) },
      // Already known.
      {
        ...base,
        id: 'ss_known',
        status: 'succeeded',
        model_calls: 3,
        cost_nano_usd: 7,
        finished_at: ago(2 * HOUR),
      },
      {
        ...base,
        id: 'ss_running',
        status: 'running',
        model_calls: 3,
        attempt: 1,
        lease_until: ago(-HOUR),
        started_at: ago(HOUR),
      },
    ]);
    const asked: Array<[string, string, string]> = [];
    const filled = await fillSecurityGatewayCosts(
      env.db,
      {
        scanTag: async (scanId) => `${scanId}.tag`,
        query: async (tag, since, until) => {
          asked.push([tag, since.toISOString(), until.toISOString()]);
          return 0.0412;
        },
      },
      NOW,
    );
    expect(filled).toBe(2);
    // From the first queue time, with ten minutes of slack each side.
    expect(asked).toEqual([
      [
        'ss_due.tag',
        new Date(NOW - 3 * HOUR - 10 * 60_000).toISOString(),
        new Date(NOW - 2 * HOUR + 10 * 60_000).toISOString(),
      ],
    ]);
    expect(await costs()).toEqual({
      ss_due: 41_200_000,
      ss_known: 7,
      ss_none: 0,
      ss_old: null,
      ss_running: null,
      ss_young: null,
    });
  });

  it('stops at the first failed query and leaves the rest for the next run', async () => {
    const { projectId, deploymentId } = await project();
    await env.db.insert(securityScans).values(
      Array.from({ length: SECURITY_GATEWAY_COST_BATCH + 2 }, (_, index) => ({
        id: `ss_${String(index).padStart(2, '0')}`,
        project_id: projectId,
        deployment_id: deploymentId,
        trigger: 'deploy' as const,
        status: 'succeeded' as const,
        model_calls: 1,
        finished_at: ago(2 * HOUR + index * 1000),
      })),
    );
    let calls = 0;
    await expect(
      fillSecurityGatewayCosts(
        env.db,
        {
          scanTag: async (scanId) => scanId,
          query: async () => {
            calls++;
            if (calls === 3) {
              throw new Error('gateway down');
            }
            return 0.01;
          },
        },
        NOW,
      ),
    ).rejects.toThrow('gateway down');
    const known = Object.values(await costs()).filter((cost) => cost !== null);
    expect(known).toEqual([10_000_000, 10_000_000]);
    // A healthy run takes one batch, oldest first.
    expect(
      await fillSecurityGatewayCosts(
        env.db,
        { scanTag: async (scanId) => scanId, query: async () => 0 },
        NOW,
      ),
    ).toBe(SECURITY_GATEWAY_COST_BATCH);
  });
});

describe('the gateway cost query', () => {
  const gateway = { accountId: 'acct', apiToken: 'secret-token', gatewayId: 'void' };
  const since = new Date('2026-11-18T09:00:00.000Z');
  const until = new Date('2026-11-18T10:00:00.000Z');

  function answer(body: unknown, status = 200): typeof fetch {
    return (async () => Response.json(body, { status })) as typeof fetch;
  }

  it('filters on the scan tag and returns the summed cost', async () => {
    let sent = '';
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string).query;
      return Response.json({
        data: { viewer: { accounts: [{ requests: [{ sum: { cost: 0.25 } }] }] } },
      });
    }) as unknown as typeof fetch;
    expect(await queryAiGatewayTagCost(gateway, 'ss_1.abc', since, until, fetcher)).toBe(0.25);
    expect(sent).toContain(
      `metadataRaw: ${JSON.stringify(JSON.stringify({ securityScan: 'ss_1.abc' }))}`,
    );
    expect(sent).toContain('gateway: "void"');
    expect(sent).toContain('datetime_geq: "2026-11-18T09:00:00.000Z"');
    expect(sent).toContain('datetime_lt: "2026-11-18T10:00:00.000Z"');
  });

  it('reads no rows as zero', async () => {
    expect(
      await queryAiGatewayTagCost(
        gateway,
        't',
        since,
        until,
        answer({ data: { viewer: { accounts: [{ requests: [] }] } } }),
      ),
    ).toBe(0);
  });

  it('throws on an HTTP error, GraphQL errors or a bad cost, and never prints the token', async () => {
    await expect(
      queryAiGatewayTagCost(gateway, 't', since, until, answer({}, 403)),
    ).rejects.toThrow('HTTP 403');
    const error = await queryAiGatewayTagCost(
      gateway,
      't',
      since,
      until,
      answer({ errors: [{ message: 'bad token secret-token' }] }),
    ).catch((caught: unknown) => (caught instanceof Error ? caught.message : String(caught)));
    expect(error).toContain('[redacted]');
    expect(error).not.toContain('secret-token');
    await expect(
      queryAiGatewayTagCost(
        gateway,
        't',
        since,
        until,
        answer({ data: { viewer: { accounts: [{ requests: [{ sum: { cost: -1 } }] }] } } }),
      ),
    ).rejects.toThrow('invalid cost');
  });
});
