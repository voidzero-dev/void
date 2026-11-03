import { eq } from 'drizzle-orm';
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
import {
  getPendingDomains,
  getPendingDomainsNewerThan,
  getPendingDomainsOlderThan,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import app, { scheduled, cleanupStalePendingDomains, FAST_CRON } from '../../src/index.ts';
import { tryActivateDomain } from '../../src/provisioning/activate-domain.ts';
import {
  domains,
  platformSettings,
  projectMembers,
  projectZeroTrust,
  users,
} from '../../src/schema.ts';
import type { Domain, Project } from '../../src/types.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfSuccess,
  cfError,
  captureQueries,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

// Shared helpers used by both scheduled() describe blocks.
const mockCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeBindings(e: TestEnv): ApiEnv['Bindings'] {
  return {
    HYPERDRIVE: e.HYPERDRIVE as unknown as Hyperdrive,
    ISR_CACHE: e.ISR_CACHE,
    ROUTING: e.ROUTING,
    STATIC_ASSETS: e.STATIC_ASSETS,
    STATIC_ASSETS_R2: e.STATIC_ASSETS_R2,
    DISPATCH: e.DISPATCH,
    CF_API_TOKEN: e.CF_API_TOKEN,
    CF_ACCOUNT_ID: e.CF_ACCOUNT_ID,
    CF_ZONE_ID: e.CF_ZONE_ID,
    JWT_SECRET: e.JWT_SECRET,
    PROJECT_SECRET_KEYS_JSON: e.PROJECT_SECRET_KEYS_JSON,
    PROJECT_SECRET_ACTIVE_KEY_VERSION: e.PROJECT_SECRET_ACTIVE_KEY_VERSION,
    R2_ACCESS_KEY_ID: e.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: e.R2_SECRET_ACCESS_KEY,
    R2_STATIC_ASSETS_BUCKET: e.R2_STATIC_ASSETS_BUCKET,
    GITHUB_CLIENT_ID: e.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: e.GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: e.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: e.GOOGLE_CLIENT_SECRET,
    USAGE_COUNTER: e.USAGE_COUNTER,
    CRON_SCHEDULER: e.CRON_SCHEDULER,
    ERROR_ALERT_MONITOR: e.ERROR_ALERT_MONITOR,
    SANDBOX_CONCURRENCY_COUNTER: e.SANDBOX_CONCURRENCY_COUNTER,
    CRON_FIRES_QUEUE: { send: async () => {}, sendBatch: async () => {} } as unknown as Queue<
      import('../../src/cron-fires-queue.ts').CronFireMessage
    >,
  } as ApiEnv['Bindings'];
}

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

describe('POST /projects/:id/domains', () => {
  it('adds a custom domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-app');
    const fetchMock = mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: 'ch-123',
          hostname: 'app.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'http',
            type: 'dv',
          },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.app.example.com',
            value: 'ownership-v',
          },
        }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'app.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      hostname: string;
      status: string;
      cname_target: string;
      ownership_verification?: { name: string; value: string };
      ssl_validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    };
    expect(body.id).toMatch(/^dom_/);
    expect(body.hostname).toBe('app.example.com');
    expect(body.status).toBe('pending');
    expect(body.cname_target).toBe('cname.void.app');
    expect(body.ownership_verification?.name).toBe('_cf-custom-hostname.app.example.com');
    // Under HTTP-DCV there are no `_acme-challenge` records; the route still
    // surfaces an (empty) array.
    expect(body.ssl_validation_records).toEqual([]);

    // Verify the CF request body has the HTTP-DCV shape and does NOT include
    // `custom_metadata` — that field requires a paid Enterprise SSL-for-SaaS
    // add-on our account is not provisioned for, and sending it causes CF to
    // reject every create.
    const cfCreateCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames') && init?.method === 'POST';
    });
    expect(cfCreateCall).toBeDefined();
    const cfBody = JSON.parse((cfCreateCall![1] as RequestInit).body as string) as {
      hostname: string;
      ssl: { method: string; type: string };
    };
    expect(cfBody.ssl.method).toBe('http');
    expect(cfBody).not.toHaveProperty('custom_metadata');
  });

  it('rolls back the CF hostname when an admin is downgraded before locked persistence', async () => {
    const owner = await createTestUser(env.db, 'domain-race-owner');
    const admin = await createTestUser(env.db, 'domain-race-admin');
    const project = await createTestProject(env.db, owner.id, 'domain-access-race');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    const fetchMock = mockCfApi({
      createCustomHostname: async () => {
        // The unlocked route check already granted settings. The downgrade
        // wins before the final project lock, so the CF first phase must be
        // compensated and no domain row may become durable.
        await env.db
          .update(projectMembers)
          .set({ role: 'reader' })
          .where(eq(projectMembers.user_id, admin.id));
        return cfSuccess({
          id: 'ch-access-race',
          hostname: 'access-race.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin.jwt}`,
        },
        body: JSON.stringify({ hostname: 'access-race.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: expect.stringMatching(/Ask (a project admin or owner|the owner)/),
    });
    expect(
      await env.db.select().from(domains).where(eq(domains.hostname, 'access-race.example.com')),
    ).toEqual([]);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/custom_hostnames/ch-access-race') &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(1);
  });

  it('compensates a protected-project create that loses the final domain-limit race', async () => {
    const user = await createTestUser(env.db, 'domain-limit-owner');
    const project = await createTestProject(env.db, user.id, 'domain-limit-race');
    await env.db.insert(projectZeroTrust).values({
      project_id: project.id,
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    await env.db.insert(domains).values(
      Array.from({ length: 99 }, (_, index) => ({
        id: `dom_limit_${index}`,
        project_id: project.id,
        hostname: `limit-${index}.example.com`,
        cf_hostname_id: `ch-limit-${index}`,
        status: 'active' as const,
      })),
    );
    const fetchMock = mockCfApi({
      createCustomHostname: async () => {
        await env.db.insert(domains).values({
          id: 'dom_limit_winner',
          project_id: project.id,
          hostname: 'limit-winner.example.com',
          cf_hostname_id: 'ch-limit-winner',
          status: 'active',
        });
        return cfSuccess({
          id: 'ch-limit-loser',
          hostname: 'limit-loser.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        });
      },
    });

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'limit-loser.example.com' }),
      }),
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Protected projects support at most 100 custom domains',
    });
    expect(
      await env.db.select().from(domains).where(eq(domains.project_id, project.id)),
    ).toHaveLength(100);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/custom_hostnames/ch-limit-loser') &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      ),
    ).toHaveLength(1);
  });

  it('returns 404 for non-existent project', async () => {
    const user = await createTestUser(env.db);
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent/domains', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'app.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(404);
  });

  it('returns 403 when user does not own project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-domain');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bob.jwt}`,
        },
        body: JSON.stringify({ hostname: 'app.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('returns 409 for duplicate hostname', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dup-domain');
    mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: 'ch-dup',
          hostname: 'taken.example.com',
          status: 'pending',
          ssl: { status: 'pending' },
        }),
    });

    // Insert existing domain
    await env.db.insert(domains).values({
      id: 'dom_existing',
      project_id: project.id,
      hostname: 'taken.example.com',
      cf_hostname_id: 'ch-existing',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'taken.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'hostname already in use' });
  });

  it('adopts an orphaned CF custom hostname when create reports a duplicate', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'adopt-orphan-domain');
    const fetchMock = mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () =>
        cfSuccess([
          {
            id: 'ch-orphan',
            hostname: 'orphan.example.com',
            status: 'pending',
            created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            ssl: {
              status: 'pending_validation',
              method: 'http',
              type: 'dv',
            },
            ownership_verification: {
              type: 'txt',
              name: '_cf-custom-hostname.orphan.example.com',
              value: 'orphan-ownership-token',
            },
          },
        ]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'orphan.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hostname: string;
      ownership_verification?: { name: string; value: string };
    };
    expect(body.hostname).toBe('orphan.example.com');
    expect(body.ownership_verification?.value).toBe('orphan-ownership-token');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'orphan.example.com'));
    expect(row?.cf_hostname_id).toBe('ch-orphan');

    const listCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames?') && (init?.method ?? 'GET') === 'GET';
    });
    expect(listCall).toBeDefined();
    const listUrl = new URL(String(listCall![0]));
    expect(listUrl.searchParams.get('hostname')).toBe('orphan.example.com');
    expect(listUrl.searchParams.has('hostname[contains]')).toBe(false);
  });

  it('passes through CF 429 when orphan lookup is rate-limited after duplicate create', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'adopt-orphan-rate-limit');
    mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () => cfError('rate limit exceeded', 429),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'orphan-rate-limited.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('rate limit exceeded');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'orphan-rate-limited.example.com'));
    expect(row).toBeUndefined();
  });

  it('falls back to the original duplicate response when orphan lookup fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'adopt-orphan-lookup-fails');
    mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () => cfError('Cloudflare unavailable', 500),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'orphan-lookup-fails.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Duplicate custom hostname found.');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'orphan-lookup-fails.example.com'));
    expect(row).toBeUndefined();
  });

  it('does not adopt a newly-created CF custom hostname from an in-flight request', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reject-inflight-domain');
    mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () =>
        cfSuccess([
          {
            id: 'ch-inflight',
            hostname: 'inflight.example.com',
            status: 'pending',
            created_at: new Date().toISOString(),
            ssl: {
              status: 'pending_validation',
              method: 'http',
              type: 'dv',
            },
          },
        ]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'inflight.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Duplicate custom hostname found.');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'inflight.example.com'));
    expect(row).toBeUndefined();
  });

  it('does not adopt an old active CF custom hostname without fresh ownership', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reject-active-orphan-domain');
    mockCfApi({
      createCustomHostname: () => cfError('Duplicate custom hostname found.', 409),
      listCustomHostnames: () =>
        cfSuccess([
          {
            id: 'ch-active-orphan',
            hostname: 'active-orphan.example.com',
            status: 'active',
            created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            ssl: { status: 'active', method: 'http', type: 'dv' },
          },
        ]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'active-orphan.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Duplicate custom hostname found.');

    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'active-orphan.example.com'));
    expect(row).toBeUndefined();
  });

  it('does not delete a newly-created CF hostname another request persisted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-db-insert-fail');
    const fetchMock = mockCfApi({
      createCustomHostname: async () => {
        await env.db.insert(domains).values({
          id: 'dom_race',
          project_id: project.id,
          hostname: 'race.example.com',
          cf_hostname_id: 'ch-race-created',
        });
        return cfSuccess({
          id: 'ch-race-created',
          hostname: 'race.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'http',
            type: 'dv',
          },
        });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'race.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'hostname already in use' });

    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/ch-race-created') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(0);

    const rows = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'race.example.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0].cf_hostname_id).toBe('ch-race-created');
  });

  it('rejects void.app subdomains', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reject-vc');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'bad.void.app' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'cannot use void.app subdomains' });
  });

  it('uses the installation domain for the CNAME target and reserved suffix', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'self-hosted-domain');
    mockCfApi({
      createCustomHostname: () =>
        cfSuccess({
          id: 'ch-self-hosted',
          hostname: 'www.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.www.example.com',
            value: 'ownership-v',
          },
        }),
    });
    const selfHostedEnv = { ...env, SITE_DOMAIN: 'apps.example.com' };
    const addDomain = (hostname: string) =>
      app.fetch(
        new Request(`http://localhost/projects/${project.id}/domains`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${user.jwt}`,
          },
          body: JSON.stringify({ hostname }),
        }),
        selfHostedEnv,
      );

    const rejected = await addDomain('bad.apps.example.com');
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'cannot use apps.example.com subdomains' });

    const added = await addDomain('www.example.com');
    expect(added.status).toBe(200);
    const body = (await added.json()) as { cname_target: string };
    expect(body.cname_target).toBe('cname.apps.example.com');
  });

  it('rejects invalid hostname format', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'invalid-host');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'not a hostname' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid hostname format' });
  });

  // CF rejects certain hostnames (e.g. reserved `.test` TLD per RFC 2606) with
  // a non-success envelope. That is a client-input problem, so the route must
  // answer 4xx with CF's message rather than let the `CloudflareApiError` reach
  // Hono's default plain-text 500.
  it('returns 400 with the CF error message when CF rejects the hostname', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-rejects');
    mockCfApi({
      createCustomHostname: () => cfError('hostname is not a valid domain', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'foo.test' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('hostname is not a valid domain');

    // No orphan DB row when CF rejects.
    const [row] = await env.db.select().from(domains).where(eq(domains.hostname, 'foo.test'));
    expect(row).toBeUndefined();
  });

  // Defense-in-depth: any unexpected throw inside an API route must surface as
  // a structured JSON 500 with a stable, GENERIC body — not Hono's bare
  // `Internal Server Error` text and not the raw `err.message` (which could
  // leak DB constraint names, connection strings, library internals, etc.).
  // The thrown error is logged server-side for prod diagnosis.
  it('returns a generic JSON 500 (no err.message leak) for unexpected route errors', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'unexpected-throw');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretMessage = 'boom: connection string postgres://user:hunter2@host/db failed';
    mockCfApi({
      createCustomHostname: () => {
        throw new Error(secretMessage);
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'unexpected.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Internal Server Error');
    // The raw exception message must NOT appear in the wire response.
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('postgres://');

    // The thrown error must be logged so prod incidents are diagnosable.
    const errMessages = errSpy.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
    );
    expect(errMessages.some((msg) => msg.includes(secretMessage))).toBe(true);
  });

  // CF 401 means our `CF_API_TOKEN` is misconfigured — server
  // fault, caller can't fix it. The caller MUST NOT see a 401 (they ARE
  // authenticated to our API) and the CF message MUST NOT leak. The error
  // re-throws to onError and becomes a generic 500.
  it('returns 500 (not 401) when CF responds with 401 (our token broken)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-401');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCfApi({
      createCustomHostname: () => cfError('Authentication error', 401),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'cf-auth-fail.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Internal Server Error');

    // Still no orphan DB row.
    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'cf-auth-fail.example.com'));
    expect(row).toBeUndefined();

    // The CF error is logged for ops.
    const errMessages = errSpy.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
    );
    expect(errMessages.some((msg) => msg.includes('Authentication error'))).toBe(true);
  });

  // CF 403 is ambiguous — it can mean a caller-fixable rule
  // (e.g. custom hostname matching the SaaS zone apex) OR an auth-class
  // failure (under-scoped `CF_API_TOKEN`, CF error code 10000). The HTTP
  // status alone can't disambiguate. To avoid leaking auth-error text
  // ("permission denied", token details, etc.) the route treats 403 the
  // same as 401: re-throw to onError → generic 500 with the CF message
  // preserved server-side in logs.
  it('returns 500 (not 403) when CF responds with 403 — auth/rule ambiguity', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-403');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cfAuthMessage = 'Authentication error (10000): API token under-scoped';
    mockCfApi({
      createCustomHostname: () => cfError(cfAuthMessage, 403),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'cf-403-case.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Internal Server Error');
    // CF auth text MUST NOT leak in the wire body.
    expect(JSON.stringify(body)).not.toContain('Authentication');
    expect(JSON.stringify(body)).not.toContain('under-scoped');

    // No orphan DB row when CF rejects pre-insert.
    const [row] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, 'cf-403-case.example.com'));
    expect(row).toBeUndefined();

    // The CF error is still logged for ops to diagnose token issues.
    const errMessages = errSpy.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
    );
    expect(errMessages.some((msg) => msg.includes(cfAuthMessage))).toBe(true);
  });

  // CF returns 429 when we hit a rate limit. The caller should see 429 so its
  // retry-after logic kicks in (rather than treating a transient throttle as
  // a permanent client error).
  it('passes through CF 429 (rate limit) so the caller can back off', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-429');
    mockCfApi({
      createCustomHostname: () => cfError('rate limit exceeded', 429),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.jwt}`,
        },
        body: JSON.stringify({ hostname: 'rate-limited.example.com' }),
      }),
      env,
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('rate limit exceeded');
  });
});

describe('GET /projects/:id/domains', () => {
  it('lists domains for a project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'list-domain');

    await env.db.insert(domains).values({
      id: 'dom_1',
      project_id: project.id,
      hostname: 'a.example.com',
      cf_hostname_id: 'ch-1',
      status: 'active',
    });
    await env.db.insert(domains).values({
      id: 'dom_2',
      project_id: project.id,
      hostname: 'b.example.com',
      cf_hostname_id: 'ch-2',
      status: 'pending',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ hostname: string; status: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].hostname).toBe('a.example.com');
    expect(body[1].hostname).toBe('b.example.com');
  });
});

describe('GET /projects/:id/domains/:domainId', () => {
  it('returns domain status from CF API', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'status-domain');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-status',
          hostname: 'status.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'txt',
            type: 'dv',
            validation_records: [
              {
                txt_name: '_acme-challenge.status.example.com',
                txt_value: 'acme-v',
                status: 'pending_validation',
              },
            ],
          },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.status.example.com',
            value: 'ownership-v',
          },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_status',
      project_id: project.id,
      hostname: 'status.example.com',
      cf_hostname_id: 'ch-status',
      status: 'pending',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_status`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hostname: string;
      status: string;
      cname_target: string;
      ssl_status: string;
      ownership_verification?: { name: string; value: string };
      ssl_validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    };
    expect(body.hostname).toBe('status.example.com');
    expect(body.status).toBe('pending');
    expect(body.cname_target).toBe('cname.void.app');
    expect(body.ssl_status).toBe('pending_validation');
    expect(body.ownership_verification?.name).toBe('_cf-custom-hostname.status.example.com');
    expect(body.ssl_validation_records).toBeDefined();
  });

  it('activates domain and writes KV when CF reports active', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'activate-domain');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-active',
          hostname: 'active.example.com',
          status: 'active',
          // A fully-validated active hostname: ownership is proven, so CF no
          // longer returns `ownership_verification`, and the edge-validated
          // cert is active.
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_activate',
      project_id: project.id,
      hostname: 'active.example.com',
      cf_hostname_id: 'ch-active',
      status: 'pending',
    });

    // Seed KV routing for the slug
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-activate-domain', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_activate`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('active');

    // Verify DB was updated
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_activate'));
    expect(row?.status).toBe('active');

    // Verify KV routing entry was written
    const domainRouting = await env.ROUTING.get('domain:active.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-activate-domain',
      projectId: project.id,
    });
  });

  it('does not write KV routing when CF reports active hostname but SSL is still validating', async () => {
    // Defense-in-depth path: CF returned `status: 'active'` (e.g. carried over
    // from a prior active state), but `ssl.status` is `pending_validation` —
    // the rare "active hostname with SSL re-validation" window during cert
    // renewal. The CF for SaaS docs require `ssl.status === 'active'` before
    // serving production traffic, so the gate must keep the domain pending.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pending-ssl');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-pending-ssl',
          hostname: 'pending-ssl.example.com',
          status: 'active',
          ssl: {
            status: 'pending_validation',
            method: 'txt',
            type: 'dv',
            validation_records: [
              {
                txt_name: '_acme-challenge.pending-ssl.example.com',
                txt_value: 'acme-v',
                status: 'pending_validation',
              },
            ],
          },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_pending_ssl',
      project_id: project.id,
      hostname: 'pending-ssl.example.com',
      cf_hostname_id: 'ch-pending-ssl',
      status: 'pending',
    });

    // Seed slug routing so the activation path COULD theoretically write.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-pending-ssl', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_pending_ssl`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      ssl_status: string;
      ssl_validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
    };
    // Response status reflects the gate, not CF's raw status.
    expect(body.status).toBe('pending');
    expect(body.ssl_status).toBe('pending_validation');
    expect(body.ssl_validation_records).toBeDefined();

    // DB row must still be pending.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_pending_ssl'));
    expect(row?.status).toBe('pending');

    // Critical assertion: KV routing entry must NOT have been written.
    const domainRouting = await env.ROUTING.get('domain:pending-ssl.example.com');
    expect(domainRouting).toBeNull();
  });

  it('activates a fully-active HTTP-DCV hostname (no ownership_verification outstanding)', async () => {
    // HTTP-DCV is the default cert-validation method. Once the hostname
    // proxies through CF, ownership is proven (CF drops `ownership_verification`)
    // and the edge-validated cert reaches `ssl.status: active`. The gate is
    // method-agnostic — it keys on `status`/`ssl.status`/`!ownership_verification`,
    // NOT `ssl.method` — so an `http`-method hostname that has cleared ownership
    // MUST activate (no migration, no stranding).
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'http-dcv-active');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-http-dcv',
          hostname: 'http-dcv.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_http_dcv',
      project_id: project.id,
      hostname: 'http-dcv.example.com',
      cf_hostname_id: 'ch-http-dcv',
      status: 'pending',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-http-dcv', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_http_dcv`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('active');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_http_dcv'));
    expect(row?.status).toBe('active');

    const domainRouting = await env.ROUTING.get('domain:http-dcv.example.com', 'json');
    expect(domainRouting).toEqual({ workerName: 'user-http-dcv', projectId: project.id });
  });

  it('does NOT activate when ownership_verification is still present despite active status', async () => {
    // Defense-in-depth: even if CF reports BOTH
    // `status: active` AND `ssl.status: active`, an outstanding
    // `ownership_verification` means the `_cf-custom-hostname` TXT is not yet
    // proven. The anti-hijack lever is the OWNERSHIP gate — a wildcard CNAME
    // (`*.victim → cname.void.app`) cannot forge the per-host ownership TXT, so
    // the gate MUST refuse to route while `ownership_verification` is present,
    // even should CF ever flip `status` early.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'ownership-outstanding');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-ownership-outstanding',
          hostname: 'ownership-outstanding.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.ownership-outstanding.example.com',
            value: 'ownership-v',
          },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_ownership_outstanding',
      project_id: project.id,
      hostname: 'ownership-outstanding.example.com',
      cf_hostname_id: 'ch-ownership-outstanding',
      status: 'pending',
    });
    // Seed slug routing so the activation path COULD theoretically write.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-ownership-outstanding', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_ownership_outstanding`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('pending');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_ownership_outstanding'));
    expect(row?.status).toBe('pending');

    // Critical assertion: KV routing entry must NOT have been written.
    expect(await env.ROUTING.get('domain:ownership-outstanding.example.com')).toBeNull();
  });

  it('activates a legacy TXT-DCV hostname (backward compat, no stranding)', async () => {
    // Backward compat: hostnames created before the HTTP-DCV switch carry
    // `ssl.method: txt`. The gate is method-agnostic, so a legacy `txt`
    // hostname that has cleared ownership (`status: active`, `ssl.status:
    // active`, no `ownership_verification`) MUST still activate — no migration,
    // no stranding of in-flight domains.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-txt');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-legacy-txt',
          hostname: 'legacy-txt.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_legacy_txt',
      project_id: project.id,
      hostname: 'legacy-txt.example.com',
      cf_hostname_id: 'ch-legacy-txt',
      status: 'pending',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-legacy-txt', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_legacy_txt`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('active');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_legacy_txt'));
    expect(row?.status).toBe('active');

    const domainRouting = await env.ROUTING.get('domain:legacy-txt.example.com', 'json');
    expect(domainRouting).toEqual({ workerName: 'user-legacy-txt', projectId: project.id });
  });

  it('returns cf_status matching CF raw status', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-status-passthrough');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-cf-status',
          hostname: 'cf-status.example.com',
          status: 'pending_validation',
          ssl: { status: 'pending_validation', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_cf_status',
      project_id: project.id,
      hostname: 'cf-status.example.com',
      cf_hostname_id: 'ch-cf-status',
      status: 'pending',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_cf_status`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cf_status: string };
    expect(body.cf_status).toBe('pending_validation');
  });

  it('awaiting_deployment is true when CF gate satisfied but slug routing absent', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'awaiting-deploy-true');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-awaiting',
          hostname: 'awaiting.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_awaiting',
      project_id: project.id,
      hostname: 'awaiting.example.com',
      cf_hostname_id: 'ch-awaiting',
      status: 'pending',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_awaiting`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; awaiting_deployment: boolean };
    expect(body.awaiting_deployment).toBe(true);
    expect(body.status).toBe('pending');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_awaiting'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:awaiting.example.com')).toBeNull();
  });

  it('awaiting_deployment is false when slug routing is present', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'awaiting-deploy-false');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-routing',
          hostname: 'routed.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_routed',
      project_id: project.id,
      hostname: 'routed.example.com',
      cf_hostname_id: 'ch-routing',
      status: 'pending',
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-routed', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_routed`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; awaiting_deployment: boolean };
    expect(body.awaiting_deployment).toBe(false);
    expect(body.status).toBe('active');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_routed'));
    expect(row?.status).toBe('active');

    expect(await env.ROUTING.get('domain:routed.example.com')).not.toBeNull();
  });

  it('awaiting_deployment is false when CF gate is not yet satisfied', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'awaiting-deploy-pending-cf');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-cf-pending',
          hostname: 'cf-pending.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_cf_pending',
      project_id: project.id,
      hostname: 'cf-pending.example.com',
      cf_hostname_id: 'ch-cf-pending',
      status: 'pending',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_cf_pending`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { awaiting_deployment: boolean };
    expect(body.awaiting_deployment).toBe(false);
  });

  it('keeps domain pending when slug routing is absent', async () => {
    // CF reports active but the project has never been deployed, so
    // `project.slug` is missing from KV. Flipping the DB row to active
    // without writing `domain:<hostname>` would leave traffic 404ing forever
    // (the gate would not fire on subsequent polls). DB and KV must
    // stay in sync — both pending until the next poll, or until a deploy
    // populates the slug entry.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-slug-routing');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-no-slug',
          hostname: 'no-slug.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'txt', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_no_slug',
      project_id: project.id,
      hostname: 'no-slug.example.com',
      cf_hostname_id: 'ch-no-slug',
      status: 'pending',
    });
    // Intentionally do NOT seed `project.slug` in ROUTING.

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_no_slug`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('pending');

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_no_slug'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:no-slug.example.com')).toBeNull();
  });

  it('does NOT re-trigger HTTP DCV via PATCH from the status route (PATCH is hourly-reconcile-only)', async () => {
    // The HTTP-DCV re-trigger PATCH is gated to the hourly reconcile tier to
    // bound CF custom-hostname API load. The authenticated status route polls CF
    // (GET) and surfaces live status, but must NOT issue a PATCH — even for a
    // pending, not-yet-gated, http-method hostname that would qualify on the
    // hourly tier.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'patch-dcv-retrigger');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-patch-pending',
          hostname: 'patch-pending.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_patch_pending',
      project_id: project.id,
      hostname: 'patch-pending.example.com',
      cf_hostname_id: 'ch-patch-pending',
      status: 'pending',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_patch_pending`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('pending');

    // CF was still polled (GET), but no PATCH was issued from the status route.
    const getCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return (
        url.includes('/custom_hostnames/ch-patch-pending') && (init?.method ?? 'GET') === 'GET'
      );
    });
    expect(getCalls.length).toBeGreaterThanOrEqual(1);

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });

  it('does NOT PATCH when CF reports fully active + gated (already validated)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'patch-skip-active');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-patch-active',
          hostname: 'patch-active.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_patch_active',
      project_id: project.id,
      hostname: 'patch-active.example.com',
      cf_hostname_id: 'ch-patch-active',
      status: 'pending',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-patch-skip-active', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_patch_active`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('active');

    // No PATCH — the gate is already satisfied.
    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });

  it('does NOT PATCH an already-active domain row', async () => {
    // wasPending is false, so even a non-gated CF response must not PATCH.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'patch-skip-already-active');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-patch-already',
          hostname: 'patch-already.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
    });

    await env.db.insert(domains).values({
      id: 'dom_patch_already',
      project_id: project.id,
      hostname: 'patch-already.example.com',
      cf_hostname_id: 'ch-patch-already',
      status: 'active',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_patch_already`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });
});

describe('DELETE /projects/:id/domains/:domainId', () => {
  it('removes a custom domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'remove-domain');
    const fetchMock = mockCfApi();

    await env.db.insert(domains).values({
      id: 'dom_remove',
      project_id: project.id,
      hostname: 'remove.example.com',
      cf_hostname_id: 'ch-remove',
      status: 'active',
    });

    // Seed KV routing for the domain
    await env.ROUTING.put('domain:remove.example.com', JSON.stringify({ projectId: project.id }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_remove`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    // Verify DB record deleted
    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_remove'));
    expect(row).toBeUndefined();

    // Verify KV routing entry deleted
    const domainRouting = await env.ROUTING.get('domain:remove.example.com');
    expect(domainRouting).toBeNull();

    // Verify CF API was called
    const deleteCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/custom_hostnames/ch-remove') && (call[1] as RequestInit)?.method === 'DELETE'
      );
    });
    expect(deleteCall).toBeDefined();
  });

  it('still deletes DB record and KV when CF hostname deletion fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cf-fail-domain');
    mockCfApi({
      deleteCustomHostname: () => {
        throw new Error('CF API down');
      },
    });

    await env.db.insert(domains).values({
      id: 'dom_cf_fail',
      project_id: project.id,
      hostname: 'cf-fail.example.com',
      cf_hostname_id: 'ch-cf-fail',
      status: 'active',
    });

    await env.ROUTING.put('domain:cf-fail.example.com', JSON.stringify({ projectId: project.id }));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_cf_fail`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings: Array<string> };
    expect(body.ok).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('CF API down');

    // DB record should still be deleted
    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_cf_fail'));
    expect(row).toBeUndefined();

    // KV routing entry should still be deleted
    const routing = await env.ROUTING.get('domain:cf-fail.example.com');
    expect(routing).toBeNull();
  });

  it('returns 404 for non-existent domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-domain');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/domains/dom_nonexistent`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(404);
  });
});

describe('scheduled() — stale pending domain janitor', () => {
  it('deletes stale (>7d) pending domains via CF + DB and leaves recent ones untouched', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-project');
    const fetchMock = mockCfApi();

    const nowMs = Date.now();
    const eightDaysAgo = new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString();

    // Backdated pending domain — beyond the 7-day janitor cutoff.
    await env.db.insert(domains).values({
      id: 'dom_stale',
      project_id: project.id,
      hostname: 'stale.example.com',
      cf_hostname_id: 'ch-stale',
      status: 'pending',
      created_at: eightDaysAgo,
    });
    // Recent pending domain — within the window, must be left alone.
    await env.db.insert(domains).values({
      id: 'dom_recent',
      project_id: project.id,
      hostname: 'recent.example.com',
      cf_hostname_id: 'ch-recent',
      status: 'pending',
    });

    const { queries } = await captureQueries(env.db, () =>
      cleanupStalePendingDomains(makeBindings(env), env.db, nowMs),
    );
    expect(queries.some((query) => /from\s+"?projects"?.*for update/i.test(query))).toBe(true);

    // Stale row is gone.
    const [staleRow] = await env.db.select().from(domains).where(eq(domains.id, 'dom_stale'));
    expect(staleRow).toBeUndefined();

    // Recent row survives, still pending.
    const [recentRow] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_recent'));
    expect(recentRow?.status).toBe('pending');

    // CF cert order was revoked for the stale hostname only.
    const deleteCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    const deleteUrls = deleteCalls.map((call) =>
      typeof call[0] === 'string' ? call[0] : String(call[0]),
    );
    expect(deleteUrls.some((url) => url.includes('/custom_hostnames/ch-stale'))).toBe(true);
    expect(deleteUrls.some((url) => url.includes('/custom_hostnames/ch-recent'))).toBe(false);
  });

  it('leaves a recent pending domain entirely untouched (no CF delete)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-recent-only');
    const fetchMock = mockCfApi();

    await env.db.insert(domains).values({
      id: 'dom_recent_only',
      project_id: project.id,
      hostname: 'recent-only.example.com',
      cf_hostname_id: 'ch-recent-only',
      status: 'pending',
    });

    const controller = { scheduledTime: Date.now() } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_recent_only'));
    expect(row?.status).toBe('pending');

    const customHostnameDeletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    expect(customHostnameDeletes).toHaveLength(0);
  });

  it('removes a deleted stale domain from protected Zero Trust destinations', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-zero-trust');
    const applications = new Map<string, Record<string, unknown>>();
    let nextApplication = 1;
    let customHostnameStatus: 'active' | 'pending' = 'active';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.includes('/custom_hostnames/')) {
          if (init?.method === 'DELETE') {
            return cfSuccess(null);
          }
          return cfSuccess({
            id: 'ch-janitor-zero-trust',
            hostname: 'stale-protected.example.com',
            status: customHostnameStatus,
            ssl: {
              status: customHostnameStatus === 'active' ? 'active' : 'pending_validation',
              method: 'http',
              type: 'dv',
            },
          });
        }
        const path = url.pathname.split('/access/')[1] ?? '';
        if (path === 'organizations') {
          return cfSuccess({ auth_domain: 'company.cloudflareaccess.com' });
        }
        if (path === 'identity_providers/idp-1') {
          return cfSuccess({ id: 'idp-1', name: 'Company SSO' });
        }
        if (path === 'policies/policy-1') {
          return cfSuccess({
            id: 'policy-1',
            decision: 'allow',
            include: [{ email_domain: { domain: 'example.com' } }],
          });
        }
        if (path === 'apps' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          const id = `app-${nextApplication++}`;
          const application = { ...body, id, aud: `aud-${id}` };
          applications.set(id, application);
          return cfSuccess(application);
        }
        if (path === 'apps') {
          return cfSuccess([...applications.values()]);
        }
        const match = /^apps\/([^/]+)$/.exec(path);
        const applicationId = match?.[1];
        if (applicationId && init?.method === 'PUT') {
          const previous = applications.get(applicationId);
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          const application = { ...body, id: applicationId, aud: previous?.aud };
          applications.set(applicationId, application);
          return cfSuccess(application);
        }
        if (applicationId && init?.method === 'DELETE') {
          applications.delete(applicationId);
          return cfSuccess({ id: applicationId });
        }
        if (applicationId) {
          return cfSuccess(applications.get(applicationId));
        }
        throw new Error(`unexpected Cloudflare request: ${url}`);
      }),
    );
    const bindings = {
      ...makeBindings(env),
      SITE_DOMAIN: 'apps.example.com',
      PLATFORM_INSTALLATION_ID: 'installation-test',
    } as ApiEnv['Bindings'];

    await configurePlatformZeroTrust(bindings, env.db, {
      apiToken: 'access-management-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: true,
      existingProjects: 'protected',
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_janitor_zero_trust',
      project_id: project.id,
      hostname: 'stale-protected.example.com',
      cf_hostname_id: 'ch-janitor-zero-trust',
      status: 'pending',
      created_at: new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const [pendingDomain] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.id, 'dom_janitor_zero_trust'));

    const activation = await tryActivateDomain(
      bindings,
      env.db,
      pendingDomain as unknown as Domain,
      project as unknown as Project,
    );
    expect(activation).toMatchObject({ activated: false, awaitingDeployment: true });
    expect(
      [...applications.values()].some((application) =>
        JSON.stringify(application.destinations).includes('stale-protected.example.com'),
      ),
    ).toBe(true);

    customHostnameStatus = 'pending';
    await cleanupStalePendingDomains(bindings, env.db, nowMs);

    const [deletedDomain] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.id, 'dom_janitor_zero_trust'));
    expect(deletedDomain).toBeUndefined();
    expect(
      [...applications.values()].some((application) =>
        JSON.stringify(application.destinations).includes('stale-protected.example.com'),
      ),
    ).toBe(false);
  });

  it('does NOT delete a stale row that CF reports active (verified after day 7)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-late-verify');
    // CF live re-check says the hostname is fully verified/active — the user
    // completed DNS late. The janitor must leave it for the status poll to
    // activate, NOT revoke its cert.
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-late',
          hostname: 'late.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_late',
      project_id: project.id,
      hostname: 'late.example.com',
      cf_hostname_id: 'ch-late',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    const controller = { scheduledTime: Date.now() } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // Row survives (still pending — the next status poll will activate it).
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_late'));
    expect(row?.status).toBe('pending');

    // No cert revocation for a verified hostname.
    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(0);
  });

  it('drops the DB row when CF reports the hostname already gone (404 on read)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-cf-gone');
    // CF already removed the hostname via its own validation cleanup — reading
    // it 404s. The janitor must drop the orphaned DB row so the customer can
    // re-add the hostname, and must NOT keep retrying forever.
    const fetchMock = mockCfApi({
      getCustomHostname: () => cfError('custom hostname not found', 404),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_cf_gone',
      project_id: project.id,
      hostname: 'cf-gone.example.com',
      cf_hostname_id: 'ch-cf-gone',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    let transactionDepth = 0;
    const originalTransaction = env.db.transaction.bind(env.db);
    vi.spyOn(env.db, 'transaction').mockImplementation(async (...args) => {
      transactionDepth += 1;
      try {
        return await originalTransaction(...args);
      } finally {
        transactionDepth -= 1;
      }
    });
    let routeDeletedUnderFence = false;
    const originalRoutingDelete = env.ROUTING.delete.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'delete').mockImplementation(async (key) => {
      if (key === 'domain:cf-gone.example.com') {
        routeDeletedUnderFence = transactionDepth > 0;
      }
      return originalRoutingDelete(key);
    });

    const controller = { scheduledTime: Date.now() } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_cf_gone'));
    expect(row).toBeUndefined();
    expect(routeDeletedUnderFence).toBe(true);

    // No DELETE attempted — CF already reported it gone on read.
    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(0);
  });

  it('treats a 404 from the CF delete as success and still removes the row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-delete-404');
    // Re-check says pending (default mock), but the cert order is already gone
    // by the time we DELETE it. A 404 there must not strand the DB row.
    const fetchMock = mockCfApi({
      deleteCustomHostname: () => cfError('custom hostname not found', 404),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_del_404',
      project_id: project.id,
      hostname: 'del-404.example.com',
      cf_hostname_id: 'ch-del-404',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    const controller = { scheduledTime: Date.now() } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_del_404'));
    expect(row).toBeUndefined();
    // The janitor did attempt the CF DELETE (and tolerated the 404).
    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/ch-del-404') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(1);
  });

  it('ACTIVATES a stale (>7d) pending domain that CF reports active + gated (backlog starvation gap)', async () => {
    // A verified-but-pending domain can age past 7 days into the janitor when
    // the reconcile backlog exceeds MAX_PENDING_RECONCILE_PER_RUN. The janitor
    // activates it when CF reports active + the gate is satisfied + slug
    // routing exists, instead of leaving it unrouted forever.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-activate');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-janitor-activate',
          hostname: 'janitor-activate.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_janitor_activate',
      project_id: project.id,
      hostname: 'janitor-activate.example.com',
      cf_hostname_id: 'ch-janitor-activate',
      status: 'pending',
      created_at: eightDaysAgo,
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-janitor-activate', projectId: project.id }),
    );

    // Call the janitor in isolation. The full hourly scheduled() runs reconcile
    // first, which would activate this gate-passing domain before the janitor
    // saw it — masking the branch under test. Calling the janitor directly
    // reproduces the >200-backlog case where the domain was excluded from
    // reconcile and only the janitor can activate it.
    await cleanupStalePendingDomains(makeBindings(env), env.db, Date.now());

    // DB row activated (not deleted).
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_janitor_activate'));
    expect(row?.status).toBe('active');

    // KV domain routing entry written.
    const domainRouting = await env.ROUTING.get('domain:janitor-activate.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-janitor-activate',
      projectId: project.id,
    });
  });

  it('does NOT activate a stale CF-active domain owned by an ADMIN-suspended account (and does NOT delete it)', async () => {
    // Parity with reconcile + the authed status route's 403: an admin-suspended
    // owner's domain must not be activated by the janitor. It must also never be
    // deleted — it is a verified host.
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'tos_violation' })
      .where(eq(users.id, user.id));
    const project = await createTestProject(env.db, user.id, 'janitor-activate-suspended');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-janitor-suspended',
          hostname: 'janitor-suspended.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
        }),
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_janitor_suspended',
      project_id: project.id,
      hostname: 'janitor-suspended.example.com',
      cf_hostname_id: 'ch-janitor-suspended',
      status: 'pending',
      created_at: eightDaysAgo,
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-janitor-activate-suspended', projectId: project.id }),
    );

    // Janitor in isolation (see the activate test above for why).
    await cleanupStalePendingDomains(makeBindings(env), env.db, Date.now());

    // Not activated, not deleted — still pending.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_janitor_suspended'));
    expect(row?.status).toBe('pending');

    // No KV write, no CF DELETE.
    expect(await env.ROUTING.get('domain:janitor-suspended.example.com')).toBeNull();
    const deletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'DELETE';
    });
    expect(deletes).toHaveLength(0);
  });

  it('retries the CF delete once when the first DELETE fails non-404, then removes the row', async () => {
    // The DB row is claimed (deleted) before the CF DELETE, so a non-404 CF
    // failure orphans the CF hostname. The janitor retries the DELETE once to
    // shrink that orphan window; a retry that succeeds must leave the row gone
    // and emit no fatal/orphan error.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'janitor-delete-retry');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let deleteAttempts = 0;
    mockCfApi({
      // Re-check says pending (default GET), so it falls through to teardown.
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-del-retry',
          hostname: 'del-retry.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
      deleteCustomHostname: () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          return cfError('internal server error', 500);
        }
        return cfSuccess(null);
      },
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_del_retry',
      project_id: project.id,
      hostname: 'del-retry.example.com',
      cf_hostname_id: 'ch-del-retry',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    // Janitor in isolation so the DELETE retry count isn't influenced by other
    // hourly maintenance.
    await cleanupStalePendingDomains(makeBindings(env), env.db, Date.now());

    // Row removed.
    const [row] = await env.db.select().from(domains).where(eq(domains.id, 'dom_del_retry'));
    expect(row).toBeUndefined();

    // Exactly two DELETE attempts (first 500, retry succeeded).
    expect(deleteAttempts).toBe(2);

    // No orphan error logged — the retry succeeded.
    const errMessages = errSpy.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
    );
    expect(errMessages.some((msg) => msg.includes('ORPHANED'))).toBe(false);
  });
});

describe('scheduled() — cron-driven auto-activation reconciliation', () => {
  // Fully-validated CF state: gate passes (status active, ssl active, no ownership_verification).
  function gatePassingCfHostname(id: string, hostname: string) {
    return cfSuccess({
      id,
      hostname,
      status: 'active',
      ssl: { status: 'active', method: 'http', type: 'dv' },
    });
  }

  it('fast tier (*/2) activates a young pending domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fast-young-activate');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-fast-young', 'fast-young.example.com'),
    });

    const nowMs = Date.now();
    // Recent domain: created 5 minutes ago, well within the 30-min window.
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_fast_young',
      project_id: project.id,
      hostname: 'fast-young.example.com',
      cf_hostname_id: 'ch-fast-young',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });

    // Seed slug routing so the project has been deployed.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-fast-young-activate', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: FAST_CRON,
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // DB row should be active.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_fast_young'));
    expect(row?.status).toBe('active');

    // KV domain routing entry must have been written.
    const domainRouting = await env.ROUTING.get('domain:fast-young.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-fast-young-activate',
      projectId: project.id,
    });
  });

  it('does not let malformed Zero Trust state starve fast domain reconciliation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fast-invalid-zero-trust');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        gatePassingCfHostname('ch-fast-invalid-zero-trust', 'invalid-zero-trust.example.com'),
    });
    await env.db.insert(platformSettings).values({
      key: 'zeroTrust.configuration',
      value: { version: 999 },
    });
    await env.db.insert(domains).values({
      id: 'dom_fast_invalid_zero_trust',
      project_id: project.id,
      hostname: 'invalid-zero-trust.example.com',
      cf_hostname_id: 'ch-fast-invalid-zero-trust',
      status: 'pending',
      created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-fast-invalid-zero-trust', projectId: project.id }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await scheduled(
      { scheduledTime: Date.now(), cron: FAST_CRON } as ScheduledController,
      makeBindings(env),
      mockCtx,
    );

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_fast_invalid_zero_trust'));
    expect(row?.status).toBe('pending');
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/custom_hostnames/ch-fast-invalid-zero-trust'),
      ),
    ).toBe(true);
  });

  it('fast tier (*/2) ignores an old pending domain (created >30 min ago)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fast-old-skip');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-fast-old', 'fast-old.example.com'),
    });

    const nowMs = Date.now();
    // Old domain: created 45 minutes ago, outside the 30-min fast-tier window.
    const fortyFiveMinutesAgo = new Date(nowMs - 45 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_fast_old',
      project_id: project.id,
      hostname: 'fast-old.example.com',
      cf_hostname_id: 'ch-fast-old',
      status: 'pending',
      created_at: fortyFiveMinutesAgo,
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-fast-old-skip', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: FAST_CRON,
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // DB row should still be pending — the fast tier skipped the old domain.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_fast_old'));
    expect(row?.status).toBe('pending');

    // No KV domain routing entry.
    expect(await env.ROUTING.get('domain:fast-old.example.com')).toBeNull();
  });

  it('hourly tier (:00) activates an old pending domain (>30 min)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'hourly-old-activate');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-hourly-old', 'hourly-old.example.com'),
    });

    const nowMs = Date.now();
    // Old domain: 45 minutes old — missed by fast tier (>30 min), caught by hourly tier.
    const fortyFiveMinutesAgo = new Date(nowMs - 45 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_hourly_old',
      project_id: project.id,
      hostname: 'hourly-old.example.com',
      cf_hostname_id: 'ch-hourly-old',
      status: 'pending',
      created_at: fortyFiveMinutesAgo,
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-hourly-old-activate', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: '0 * * * *',
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // DB row should be active.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_hourly_old'));
    expect(row?.status).toBe('active');

    // KV domain routing entry written. The hourly rollover loop may backfill
    // userId, so use objectContaining to assert the essential fields.
    const domainRouting = await env.ROUTING.get('domain:hourly-old.example.com', 'json');
    expect(domainRouting).toMatchObject({
      workerName: 'user-hourly-old-activate',
      projectId: project.id,
    });
  });

  it('hourly tier re-triggers HTTP DCV via PATCH for a pending, ungated, http-method domain', async () => {
    // Void's add-first flow creates the CF hostname with ssl.method:'http'
    // BEFORE the user points their CNAME at cname.void.app. CF requires a PATCH
    // to complete HTTP validation once the domain is pointing at the Managed
    // CNAME — a GET alone never re-triggers DCV and the hostname can stay
    // pending forever (or get CF-deleted after 7 days). The re-trigger is gated
    // to the HOURLY reconcile tier (to bound CF API load), so an hourly run over
    // a pending, not-yet-gated, http-method domain must issue exactly one
    // no-change PATCH.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'hourly-patch-retrigger');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-hourly-patch',
          hostname: 'hourly-patch.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_hourly_patch',
      project_id: project.id,
      hostname: 'hourly-patch.example.com',
      cf_hostname_id: 'ch-hourly-patch',
      status: 'pending',
      created_at: new Date(nowMs - 45 * 60 * 1000).toISOString(),
    });

    const controller = { scheduledTime: nowMs, cron: '0 * * * *' } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // Exactly one PATCH to this hostname re-triggered DCV.
    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/ch-hourly-patch') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(1);
    // The PATCH re-sends the ssl block (no hostname mutation).
    const patchBody = JSON.parse((patchCalls[0][1] as RequestInit).body as string) as {
      ssl: { method: string; type: string };
    };
    expect(patchBody.ssl.method).toBe('http');
    expect(patchBody.ssl.type).toBe('dv');

    // Still pending — the gate is not yet satisfied.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_hourly_patch'));
    expect(row?.status).toBe('pending');
  });

  it('fast tier does NOT PATCH a pending, ungated, http-method young domain (CF still polled)', async () => {
    // The fast (*/2) tier reconciles young pending domains but must NOT issue
    // the HTTP-DCV re-trigger PATCH — that is hourly-only to bound CF API load.
    // CF is still polled (GET) so a now-gated domain would activate.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fast-no-patch');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-fast-no-patch',
          hostname: 'fast-no-patch.example.com',
          status: 'pending',
          ssl: { status: 'pending_validation', method: 'http', type: 'dv' },
        }),
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_fast_no_patch',
      project_id: project.id,
      hostname: 'fast-no-patch.example.com',
      cf_hostname_id: 'ch-fast-no-patch',
      status: 'pending',
      created_at: new Date(nowMs - 5 * 60 * 1000).toISOString(),
    });

    const controller = { scheduledTime: nowMs, cron: FAST_CRON } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // CF polled (GET) but no PATCH.
    const getCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return (
        url.includes('/custom_hostnames/ch-fast-no-patch') && (init?.method ?? 'GET') === 'GET'
      );
    });
    expect(getCalls.length).toBeGreaterThanOrEqual(1);

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });

  it('hourly tier does NOT PATCH a fully-active + gated domain (activates as before)', async () => {
    // A gate-passing domain activates without any PATCH — the re-trigger only
    // fires for the not-yet-gated long tail.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'hourly-gated-no-patch');
    const fetchMock = mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-hourly-gated', 'hourly-gated.example.com'),
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_hourly_gated',
      project_id: project.id,
      hostname: 'hourly-gated.example.com',
      cf_hostname_id: 'ch-hourly-gated',
      status: 'pending',
      created_at: new Date(nowMs - 45 * 60 * 1000).toISOString(),
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-hourly-gated-no-patch', projectId: project.id }),
    );

    const controller = { scheduledTime: nowMs, cron: '0 * * * *' } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // Activated, no PATCH.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_hourly_gated'));
    expect(row?.status).toBe('active');

    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);
  });

  it('hourly tier does NOT PATCH a legacy TXT-method pending domain (leaves it on txt)', async () => {
    // A LEGACY pending hostname created under the TXT-DCV flow
    // (cf.ssl.method === 'txt', user still publishing `_acme-challenge` records) must NOT be PATCHed to HTTP-DCV by the hourly
    // reconcile — doing so would discard the user's in-progress validation
    // method and break the no-migration guarantee. It also must not be
    // mis-activated while still pending+ungated.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'hourly-legacy-txt');
    const fetchMock = mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-hourly-legacy-txt',
          hostname: 'hourly-legacy-txt.example.com',
          status: 'pending',
          ssl: {
            status: 'pending_validation',
            method: 'txt',
            type: 'dv',
            validation_records: [
              {
                txt_name: '_acme-challenge.hourly-legacy-txt.example.com',
                txt_value: 'acme-v',
                status: 'pending_validation',
              },
            ],
          },
        }),
    });

    const nowMs = Date.now();
    await env.db.insert(domains).values({
      id: 'dom_hourly_legacy_txt',
      project_id: project.id,
      hostname: 'hourly-legacy-txt.example.com',
      cf_hostname_id: 'ch-hourly-legacy-txt',
      status: 'pending',
      created_at: new Date(nowMs - 45 * 60 * 1000).toISOString(),
    });

    const controller = { scheduledTime: nowMs, cron: '0 * * * *' } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // No PATCH — the legacy txt hostname keeps its existing method.
    const patchCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes('/custom_hostnames/') && init?.method === 'PATCH';
    });
    expect(patchCalls).toHaveLength(0);

    // Not mis-activated — still pending.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_hourly_legacy_txt'));
    expect(row?.status).toBe('pending');
  });

  it('gate not satisfied (ownership_verification still present) — never activated on either tier', async () => {
    // Even with active status+ssl, an outstanding
    // ownership_verification means the anti-hijack gate must block activation.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gate-blocked');
    mockCfApi({
      getCustomHostname: () =>
        cfSuccess({
          id: 'ch-gate-blocked',
          hostname: 'gate-blocked.example.com',
          status: 'active',
          ssl: { status: 'active', method: 'http', type: 'dv' },
          ownership_verification: {
            type: 'txt',
            name: '_cf-custom-hostname.gate-blocked.example.com',
            value: 'ownership-v',
          },
        }),
    });

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_gate_blocked',
      project_id: project.id,
      hostname: 'gate-blocked.example.com',
      cf_hostname_id: 'ch-gate-blocked',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-gate-blocked', projectId: project.id }),
    );

    // Test both tiers.
    for (const cron of [FAST_CRON, '0 * * * *']) {
      const controller = { scheduledTime: nowMs, cron } as ScheduledController;
      await scheduled(controller, makeBindings(env), mockCtx);
    }

    // Still pending — gate blocked it.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_gate_blocked'));
    expect(row?.status).toBe('pending');

    expect(await env.ROUTING.get('domain:gate-blocked.example.com')).toBeNull();
  });

  it('gate satisfied but no slug routing (awaiting deployment) — stays pending, no KV write', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'awaiting-deploy-cron');
    mockCfApi({
      getCustomHostname: () =>
        gatePassingCfHostname('ch-awaiting-deploy', 'awaiting-deploy.example.com'),
    });

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_awaiting_deploy',
      project_id: project.id,
      hostname: 'awaiting-deploy.example.com',
      cf_hostname_id: 'ch-awaiting-deploy',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });
    // Intentionally do NOT seed slug routing — project never deployed.

    const controller = {
      scheduledTime: nowMs,
      cron: FAST_CRON,
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // Stays pending.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_awaiting_deploy'));
    expect(row?.status).toBe('pending');

    // No KV write.
    expect(await env.ROUTING.get('domain:awaiting-deploy.example.com')).toBeNull();
  });

  it('reconcile runs before cleanup: a >7d domain whose gate just passed is activated not deleted', async () => {
    // Ordering proof: if reconcile ran AFTER cleanup, the domain would be
    // garbage-collected. Running it before means a just-validated domain near
    // the 7-day cutoff is activated instead.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reconcile-before-cleanup');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-near-cutoff', 'near-cutoff.example.com'),
    });

    const nowMs = Date.now();
    // Domain is 8 days old — older than the 7-day janitor cutoff.
    const eightDaysAgo = new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_near_cutoff',
      project_id: project.id,
      hostname: 'near-cutoff.example.com',
      cf_hostname_id: 'ch-near-cutoff',
      status: 'pending',
      created_at: eightDaysAgo,
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-near-cutoff', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: '0 * * * *',
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // Domain was activated (not deleted) because reconcile ran first.
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_near_cutoff'));
    expect(row?.status).toBe('active');

    // The hourly rollover loop may backfill userId, so use toMatchObject.
    const domainRouting = await env.ROUTING.get('domain:near-cutoff.example.com', 'json');
    expect(domainRouting).toMatchObject({
      workerName: 'user-near-cutoff',
      projectId: project.id,
    });
  });

  it('per-domain isolation: first domain CF error does not prevent second domain from activating', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'isolation-project');

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();

    await env.db.insert(domains).values({
      id: 'dom_iso_fail',
      project_id: project.id,
      hostname: 'iso-fail.example.com',
      cf_hostname_id: 'ch-iso-fail',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });
    await env.db.insert(domains).values({
      id: 'dom_iso_ok',
      project_id: project.id,
      hostname: 'iso-ok.example.com',
      cf_hostname_id: 'ch-iso-ok',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });

    // The mock returns an error for the first hostname and success for the second.
    mockCfApi({
      getCustomHostname: (_url: string) => {
        if (_url.includes('ch-iso-fail')) {
          throw new Error('CF API unavailable');
        }
        return gatePassingCfHostname('ch-iso-ok', 'iso-ok.example.com');
      },
    });

    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-isolation-project', projectId: project.id }),
    );

    const controller = {
      scheduledTime: nowMs,
      cron: FAST_CRON,
    } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    // First domain: still pending (CF threw).
    const [failRow] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_iso_fail'));
    expect(failRow?.status).toBe('pending');

    // Second domain: activated despite the first one failing.
    const [okRow] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_iso_ok'));
    expect(okRow?.status).toBe('active');

    const domainRouting = await env.ROUTING.get('domain:iso-ok.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-isolation-project',
      projectId: project.id,
    });
  });

  it('does NOT activate a domain owned by an ADMIN-suspended account', async () => {
    // Parity with the authenticated `void domain status` route, which is behind
    // authMiddleware and 403s admin-suspended owners. The cron must not advance
    // a domain the authed path refuses.
    const user = await createTestUser(env.db);
    // An admin suspension is any reason that is NOT a usage-limit reason.
    await env.db
      .update(users)
      .set({ suspended_reason: 'tos_violation' })
      .where(eq(users.id, user.id));
    const project = await createTestProject(env.db, user.id, 'admin-suspended-skip');
    mockCfApi({
      getCustomHostname: () =>
        gatePassingCfHostname('ch-admin-suspended', 'admin-suspended.example.com'),
    });

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_admin_suspended',
      project_id: project.id,
      hostname: 'admin-suspended.example.com',
      cf_hostname_id: 'ch-admin-suspended',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });
    // Project HAS been deployed — slug routing present, so the only thing
    // blocking activation is the admin suspension.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-admin-suspended-skip', projectId: project.id }),
    );

    // Run both tiers — neither must activate.
    for (const cron of [FAST_CRON, '0 * * * *']) {
      const controller = { scheduledTime: nowMs, cron } as ScheduledController;
      await scheduled(controller, makeBindings(env), mockCtx);
    }

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_admin_suspended'));
    expect(row?.status).toBe('pending');
    expect(await env.ROUTING.get('domain:admin-suspended.example.com')).toBeNull();
  });

  it('CONTROL: still activates a domain owned by a USAGE-suspended account', async () => {
    // Usage-suspended owners (isAdminSuspended === false) retain access, so the
    // cron must still reconcile and activate their domains.
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));
    const project = await createTestProject(env.db, user.id, 'usage-suspended-activate');
    mockCfApi({
      getCustomHostname: () =>
        gatePassingCfHostname('ch-usage-suspended', 'usage-suspended.example.com'),
    });

    const nowMs = Date.now();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60 * 1000).toISOString();
    await env.db.insert(domains).values({
      id: 'dom_usage_suspended',
      project_id: project.id,
      hostname: 'usage-suspended.example.com',
      cf_hostname_id: 'ch-usage-suspended',
      status: 'pending',
      created_at: fiveMinutesAgo,
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-usage-suspended-activate', projectId: project.id }),
    );

    const controller = { scheduledTime: nowMs, cron: FAST_CRON } as ScheduledController;
    await scheduled(controller, makeBindings(env), mockCtx);

    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_usage_suspended'));
    expect(row?.status).toBe('active');
    const domainRouting = await env.ROUTING.get('domain:usage-suspended.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-usage-suspended-activate',
      projectId: project.id,
    });
  });

  it('tryActivateDomain activates a genuinely-pending gate-passing domain (positive control)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'claim-first-positive');
    mockCfApi({
      getCustomHostname: () => gatePassingCfHostname('ch-positive', 'positive.example.com'),
    });

    await env.db.insert(domains).values({
      id: 'dom_race_positive',
      project_id: project.id,
      hostname: 'positive.example.com',
      cf_hostname_id: 'ch-positive',
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-claim-first-positive', projectId: project.id }),
    );

    const [pendingRow] = await env.db
      .select()
      .from(domains)
      .where(eq(domains.id, 'dom_race_positive'));
    const result = await tryActivateDomain(
      makeBindings(env),
      env.db,
      pendingRow as unknown as Domain,
      project as unknown as Project,
    );

    expect(result.activated).toBe(true);
    const [row] = await env.db
      .select({ status: domains.status })
      .from(domains)
      .where(eq(domains.id, 'dom_race_positive'));
    expect(row?.status).toBe('active');
    const domainRouting = await env.ROUTING.get('domain:positive.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: 'user-claim-first-positive',
      projectId: project.id,
    });
  });

  it('getPendingDomains(limit) returns exactly `limit` rows oldest-first', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'limit-ordering');

    const baseMs = Date.now() - 10 * 60 * 60 * 1000;
    // Insert 5 pending domains with distinct, increasing created_at.
    for (let i = 0; i < 5; i++) {
      await env.db.insert(domains).values({
        id: `dom_limit_${i}`,
        project_id: project.id,
        hostname: `limit-${i}.example.com`,
        cf_hostname_id: `ch-limit-${i}`,
        status: 'pending',
        created_at: new Date(baseMs + i * 60 * 1000).toISOString(),
      });
    }

    const got = await getPendingDomains(env.db, 3);
    expect(got.length).toBe(3);
    // Oldest-first: ids 0,1,2.
    expect(got.map((d) => d.id)).toEqual(['dom_limit_0', 'dom_limit_1', 'dom_limit_2']);

    // Same ordering/cap semantics for the fast-tier query (all 5 are within the
    // window since the cutoff is well before baseMs).
    const cutoff = new Date(baseMs - 60 * 60 * 1000).toISOString();
    const young = await getPendingDomainsNewerThan(env.db, cutoff, 2);
    expect(young.length).toBe(2);
    expect(young.map((d) => d.id)).toEqual(['dom_limit_0', 'dom_limit_1']);
  });

  it('getPendingDomainsOlderThan(cutoff, limit) returns exactly `limit` rows oldest-first', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stale-limit-ordering');

    // Use a cutoff in the future relative to the inserted rows so all rows are
    // "older than" the cutoff. Insert N rows with distinct, increasing created_at.
    const N = 5;
    const baseMs = Date.now() - 20 * 24 * 60 * 60 * 1000; // 20 days ago
    for (let i = 0; i < N; i++) {
      await env.db.insert(domains).values({
        id: `dom_stale_limit_${i}`,
        project_id: project.id,
        hostname: `stale-limit-${i}.example.com`,
        cf_hostname_id: `ch-stale-limit-${i}`,
        status: 'pending',
        created_at: new Date(baseMs + i * 60 * 1000).toISOString(),
      });
    }

    const cutoff = new Date(baseMs + N * 60 * 1000).toISOString(); // after all rows

    // k < N → returns exactly k, oldest-first.
    const k = 3;
    const got = await getPendingDomainsOlderThan(env.db, cutoff, k);
    expect(got.length).toBe(k);
    expect(got.map((d) => d.id)).toEqual([
      'dom_stale_limit_0',
      'dom_stale_limit_1',
      'dom_stale_limit_2',
    ]);
  });
});
