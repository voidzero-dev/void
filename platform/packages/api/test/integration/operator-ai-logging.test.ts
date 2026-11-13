import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vite-plus/test';
import {
  aiLoggingClearedKey,
  aiLoggingKey,
  PLAN_AI_LOGGING_SETTING,
} from '../../src/ai-logging-policy.ts';
import {
  AI_LOGGING_SETTLE_MS,
  lockAiLoggingProjectStatement,
  lockNewProjectAiLoggingInputs,
  publishAfterAiLoggingSave,
  publishProjectAiLogging,
  readProjectAiLoggingStatus,
  saveProjectAiLogging,
  writeProjectAiLogging,
} from '../../src/ai-logging.ts';
import { createProject } from '../../src/db/projects.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { PLAN_CATALOG_SETTING } from '../../src/plans.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import { deriveProxyInternalAuth, PROXY_INTERNAL_AUTH_HEADER } from '../../src/proxy-token.ts';
import { projectAiLogging, projects } from '../../src/schema.ts';
import {
  captureQueries,
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

// Hosted Void Cloud does not set PLATFORM_AUTH_DATABASE_UNCACHED. Nothing here may
// depend on it.
let env: TestEnv;
let token: string;

beforeAll(async () => {
  env = await setupEnv({ authDatabaseUncached: false });
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  for (const prefix of ['ai-logging:', 'ai-logging-cleared:']) {
    for (const { name } of (await env.ROUTING.list({ prefix })).keys) {
      await env.ROUTING.delete(name);
    }
  }
  const admin = await createTestUser(
    env.db,
    'operator-admin',
    'github',
    undefined,
    'free',
    'admin',
  );
  token = await createOperatorToken(env.db, admin);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function operator(
  path: string,
  body?: Record<string, unknown>,
  overrides?: Partial<ApiEnv['Bindings']>,
) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { ...env, ...overrides },
  );
}

async function setMode(projectId: string, mode: string) {
  return operator(`/projects/${projectId}/ai-logging`, { mode });
}

async function published(projectId: string) {
  return env.ROUTING.getWithMetadata(aiLoggingKey(projectId));
}

async function savedRow(projectId: string) {
  const [row] = await env.db
    .select({ mode: projectAiLogging.mode })
    .from(projectAiLogging)
    .where(eq(projectAiLogging.project_id, projectId));
  return row?.mode ?? null;
}

async function seedProject(plan = 'free') {
  const owner = await createTestUser(env.db, 'ai-owner', 'github', undefined, plan);
  return createTestProject(env.db, owner.id);
}

/** Fails ROUTING writes to AI logging keys only; other keys keep working. */
function failAiLoggingWrites(method: 'put' | 'delete', error = new Error('KV unavailable')) {
  const original = env.ROUTING[method].bind(env.ROUTING) as (...args: Array<unknown>) => unknown;
  return vi.spyOn(env.ROUTING, method).mockImplementation((async (
    key: string,
    ...rest: Array<unknown>
  ) => {
    if (key.startsWith('ai-logging:')) {
      throw error;
    }
    return original(key, ...rest);
  }) as never);
}

/** Skips the real 1 s / 2 s / 4 s waits between KV 429 retries. */
function skipRetryWaits() {
  const realSetTimeout = globalThis.setTimeout;
  return vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((callback: () => void, ms?: number) =>
      realSetTimeout(callback, ms !== undefined && ms >= 1000 ? 0 : ms)) as never);
}

describe('operator project override', () => {
  test('publishes off with metadata and an expected time, and inherit removes both', async () => {
    const project = await seedProject();
    const before = Date.now();
    const response = await setMode(project.id, 'off');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      mode: 'off',
      planId: 'free',
      planMode: null,
      effective: 'off',
      source: 'project',
      previous: 'inherit',
    });
    expect(await savedRow(project.id)).toBe('off');
    const key = await published(project.id);
    expect(key.value).toBe('off');
    const metadata = key.metadata as { mode: string; at: number };
    expect(metadata.mode).toBe('off');
    expect(metadata.at).toBeGreaterThanOrEqual(before);
    expect(body.expectedBy).toBe(new Date(metadata.at + AI_LOGGING_SETTLE_MS).toISOString());

    const cleared = await setMode(project.id, 'inherit');
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      mode: 'inherit',
      effective: 'inherit',
      source: 'gateway',
      expectedBy: expect.any(String),
    });
    expect(await savedRow(project.id)).toBeNull();
    expect(await published(project.id)).toEqual({ value: null, metadata: null });
  });

  test('a dry run changes nothing and shows what would apply', async () => {
    const project = await seedProject();
    const response = await operator(`/projects/${project.id}/ai-logging`, {
      mode: 'off',
      dryRun: true,
    });
    expect(await response.json()).toMatchObject({
      dryRun: true,
      mode: 'off',
      effective: 'off',
      previous: 'inherit',
    });
    expect(await savedRow(project.id)).toBeNull();
    expect((await published(project.id)).value).toBeNull();
  });

  test('a failed tighten publish rolls the change back', async () => {
    const project = await seedProject();
    expect((await setMode(project.id, 'full')).status).toBe(200);
    failAiLoggingWrites('put');
    const response = await setMode(project.id, 'off');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'ai_logging_publish_failed' });
    expect(await savedRow(project.id)).toBe('full');
    expect((await published(project.id)).value).toBe('full');
  });

  test('a failed loosen publish keeps the saved row and the old key, and a retry converges', async () => {
    const project = await seedProject();
    expect((await setMode(project.id, 'off')).status).toBe(200);
    const failing = failAiLoggingWrites('put');
    const response = await setMode(project.id, 'full');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'ai_logging_publish_pending' });
    expect(await savedRow(project.id)).toBe('full');
    expect((await published(project.id)).value).toBe('off');
    failing.mockRestore();

    const retry = await setMode(project.id, 'full');
    expect(retry.status).toBe(200);
    expect((await published(project.id)).value).toBe('full');
  });

  test('a failed retry after a pending loosen names the setting that stays saved', async () => {
    const project = await seedProject();
    expect((await setMode(project.id, 'off')).status).toBe(200);
    failAiLoggingWrites('put');
    expect(await (await setMode(project.id, 'full')).json()).toMatchObject({
      error: 'ai_logging_publish_pending',
      message: expect.stringContaining('hourly repair publishes it'),
    });
    // The retry runs as "same" in one transaction and fails again. The first call's
    // save stays, and the hourly sweep will publish it, so "nothing changed" would mislead.
    const retry = await setMode(project.id, 'full');
    expect(retry.status).toBe(503);
    const body = (await retry.json()) as { error: string; message: string };
    expect(body.error).toBe('ai_logging_publish_failed');
    expect(body.message).toContain('The saved project setting is still "full"');
    expect(body.message).not.toContain('nothing was changed');
    expect(await savedRow(project.id)).toBe('full');
    expect((await published(project.id)).value).toBe('off');
  });

  test.each([
    ['inherit', 'full', 'put'],
    ['full', 'inherit', 'delete'],
  ] as const)('%s -> %s publishes after the commit', async (from, to, write) => {
    const project = await seedProject();
    expect((await setMode(project.id, from)).status).toBe(200);
    const failing = failAiLoggingWrites(write);
    const response = await setMode(project.id, to);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'ai_logging_publish_pending' });
    expect(await savedRow(project.id)).toBe(to === 'inherit' ? null : to);
    expect((await published(project.id)).value).toBe(from === 'inherit' ? null : from);
    failing.mockRestore();

    const before = Date.now();
    const retry = await setMode(project.id, to);
    expect(retry.status).toBe(200);
    const { expectedBy } = (await retry.json()) as { expectedBy: string };
    expect(Date.parse(expectedBy)).toBeGreaterThanOrEqual(before + AI_LOGGING_SETTLE_MS);
    expect((await published(project.id)).value).toBe(to === 'inherit' ? null : to);
  });

  test('a late loosen publish re-reads under the lock and cannot undo a newer tighten', async () => {
    const project = await seedProject();
    expect((await setMode(project.id, 'off')).status).toBe(200);
    // A: off -> full commits its first transaction, then stalls before publishing.
    const options = { initialPlanDefault: 'free' as const, dryRun: false };
    const a = await saveProjectAiLogging(env.db, env.ROUTING, project.id, 'full', options);
    expect(a).toMatchObject({ publishAfterCommit: true });
    // B: full -> off runs to completion.
    expect((await setMode(project.id, 'off')).status).toBe(200);
    // A publishes now: it must write what the row holds, not its own value.
    await publishAfterAiLoggingSave(env.db, env.ROUTING, project.id, {
      initialPlanDefault: 'free',
      previous: 'off',
    });
    expect((await published(project.id)).value).toBe('off');
  });

  test('retries a KV 429 while holding the lock', async () => {
    const project = await seedProject();
    skipRetryWaits();
    const put = env.ROUTING.put.bind(env.ROUTING);
    let calls = 0;
    vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      ...rest: [string, KVNamespacePutOptions?]
    ) => {
      if (key.startsWith('ai-logging:') && calls++ === 0) {
        throw new Error('KV PUT failed: 429 Too Many Requests');
      }
      return put(key, ...rest);
    }) as never);
    expect((await setMode(project.id, 'off')).status).toBe(200);
    expect(calls).toBe(2);
    expect((await published(project.id)).value).toBe('off');
  });

  test('gives up after the fourth 429', async () => {
    const project = await seedProject();
    expect((await setMode(project.id, 'full')).status).toBe(200);
    skipRetryWaits();
    const failing = failAiLoggingWrites('put', new Error('KV PUT failed: 429 Too Many Requests'));
    const response = await setMode(project.id, 'off');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'ai_logging_publish_failed' });
    expect(failing).toHaveBeenCalledTimes(4);
    expect(await savedRow(project.id)).toBe('full');
  });

  test('refuses a project that is being deleted', async () => {
    const project = await seedProject();
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    expect((await setMode(project.id, 'off')).status).toBe(409);
    expect((await setMode('proj_000000000404', 'off')).status).toBe(404);
  });

  test('reads every publish input through one write statement', async () => {
    const project = await seedProject();
    await env.db.insert(projectAiLogging).values({ project_id: project.id, mode: 'metadata' });
    const { queries } = await captureQueries(env.db, () =>
      env.db.transaction((tx) =>
        publishProjectAiLogging(tx, env.ROUTING, project.id, {
          trigger: 'operator',
          initialPlanDefault: 'free',
        }),
      ),
    );
    const statements = queries.map((query) => query.trim().split(' ')[0]!.toLowerCase());
    expect(statements).not.toContain('select');
    expect(statements.filter((statement) => statement === 'update')).toHaveLength(2);
    // The lock comes first, on its own: a statement that waits for the lock keeps
    // the joined rows it read before the wait, so the inputs are read after it.
    const [lock, inputs] = queries.filter((query) =>
      query.trim().toLowerCase().startsWith('update'),
    );
    expect(lock!.toLowerCase()).not.toContain(' from ');
    expect(lock!.toLowerCase()).not.toContain(' join ');
    expect(inputs).toContain('"project_ai_logging"');
    expect((await published(project.id)).value).toBe('metadata');
  });

  // Needs real PostgreSQL: PGlite runs one connection, so nothing ever waits on a lock.
  test.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'a publisher that waited for the lock writes the change committed during its wait',
    async () => {
      const project = await seedProject();
      expect((await setMode(project.id, 'full')).status).toBe(200);
      let release!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // B: full -> off holds the project lock while it saves.
      const b = env.db.transaction(async (tx) => {
        await tx.execute(lockAiLoggingProjectStatement(project.id));
        await writeProjectAiLogging(tx, project.id, 'off');
        locked();
        await mayCommit;
      });
      // Racing B shows its own error at once if it fails before it signals.
      await Promise.race([holding, b]);
      // A: a late publish that has to wait for B's lock.
      let done = false;
      const a = publishAfterAiLoggingSave(env.db, env.ROUTING, project.id, {
        initialPlanDefault: 'free',
        previous: 'off',
      }).then((result) => {
        done = true;
        return result;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(done).toBe(false);
      } finally {
        // Never leave the lock held for the tests that follow.
        release();
        await b;
      }
      expect(await a).toMatchObject({ effective: 'off' });
      expect((await published(project.id)).value).toBe('off');
    },
  );
});

describe('plan defaults', () => {
  async function setPlanDefaults(modes: Record<string, string>, publish: unknown = null) {
    await setPlatformSetting(env.db, PLAN_AI_LOGGING_SETTING, { modes, publish });
  }

  test('a project override wins over the plan default, and removing it falls back', async () => {
    await setPlanDefaults({ pro: 'metadata' });
    const project = await seedProject('pro');
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      mode: 'inherit',
      planId: 'pro',
      planKnown: true,
      planMode: 'metadata',
      effective: 'metadata',
      source: 'plan',
    });
    expect(await (await setMode(project.id, 'full')).json()).toMatchObject({
      effective: 'full',
      source: 'project',
      previous: 'metadata',
    });
    expect((await published(project.id)).value).toBe('full');
    expect(await (await setMode(project.id, 'inherit')).json()).toMatchObject({
      mode: 'inherit',
      effective: 'metadata',
      source: 'plan',
    });
    expect(await published(project.id)).toMatchObject({
      value: 'metadata',
      metadata: { mode: 'metadata' },
    });
  });

  test('an account on an unknown plan follows the default plan, with no catalog row', async () => {
    await setPlanDefaults({ free: 'off' });
    const project = await seedProject('legacy-x');
    expect(await (await setMode(project.id, 'full')).json()).toMatchObject({ effective: 'full' });
    expect(await (await setMode(project.id, 'inherit')).json()).toMatchObject({
      planId: 'legacy-x',
      planKnown: false,
      defaultPlanId: 'free',
      planMode: 'off',
      effective: 'off',
      source: 'plan',
    });
    expect((await published(project.id)).value).toBe('off');
  });

  test('a self-hosted install without a saved catalog defaults unknown plans to custom', async () => {
    await setPlanDefaults({ custom: 'metadata', free: 'off' });
    const project = await seedProject('legacy-x');
    const response = await operator(`/projects/${project.id}/ai-logging`, undefined, {
      PLATFORM_INSTALLATION_ID: 'install-1',
    });
    expect(await response.json()).toMatchObject({
      defaultPlanId: 'custom',
      planMode: 'metadata',
      effective: 'metadata',
    });
  });

  test('a saved catalog decides the default plan', async () => {
    const catalog = await import('@void/platform/plans').then((plans) =>
      plans.createDefaultPlanCatalog('free'),
    );
    await setPlatformSetting(env.db, PLAN_CATALOG_SETTING, { ...catalog, defaultPlanId: 'pro' });
    await setPlanDefaults({ pro: 'off' });
    const project = await seedProject('legacy-x');
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      defaultPlanId: 'pro',
      effective: 'off',
    });
  });

  test('invalid saved plan defaults stop the publish instead of loosening', async () => {
    await setPlatformSetting(env.db, PLAN_AI_LOGGING_SETTING, { modes: { free: 'bogus' } });
    const project = await seedProject();
    const response = await setMode(project.id, 'off');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'invalid_saved_plan_ai_logging',
      // Plan commands read the same value first, so the message must not send the operator there.
      message: expect.not.stringContaining('plan default again'),
    });
    expect((await published(project.id)).value).toBeNull();
  });

  test('readback says pending_plan_publish while a plan publish has not reached the project', async () => {
    await setPlanDefaults(
      { pro: 'off' },
      { revision: 0, planIds: ['pro'], includeUnknown: false, cursor: null, complete: false },
    );
    const project = await seedProject('pro');
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      effective: 'off',
      published: 'inherit',
      state: 'pending_plan_publish',
    });
  });
});

describe('readback', () => {
  test('project show keeps mode and adds the published state', async () => {
    const project = await seedProject();
    expect(await (await operator(`/projects/${project.id}`)).json()).toMatchObject({
      aiLogging: {
        mode: 'inherit',
        effective: 'inherit',
        source: 'gateway',
        published: 'inherit',
        state: 'applied',
      },
    });
    const change = (await (await setMode(project.id, 'off')).json()) as { expectedBy: string };
    expect(await (await operator(`/projects/${project.id}`)).json()).toMatchObject({
      aiLogging: { mode: 'off', effective: 'off', published: 'off', state: 'pending' },
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(change.expectedBy) + 1);
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      mode: 'off',
      published: 'off',
      state: 'applied',
    });
  });

  test('a change to inherit reads pending until the settle time passes', async () => {
    const project = await seedProject();
    expect((await setMode(project.id, 'off')).status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + AI_LOGGING_SETTLE_MS + 1);
    const change = (await (await setMode(project.id, 'inherit')).json()) as {
      expectedBy: string;
    };
    expect(await published(project.id)).toEqual({ value: null, metadata: null });
    // Other locations may still serve the cached 'off' until the settle time.
    expect(await (await operator(`/projects/${project.id}`)).json()).toMatchObject({
      aiLogging: {
        mode: 'inherit',
        effective: 'inherit',
        published: 'inherit',
        publishedAt: new Date(Date.parse(change.expectedBy) - AI_LOGGING_SETTLE_MS).toISOString(),
        state: 'pending',
      },
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(change.expectedBy) + 1);
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      published: 'inherit',
      publishedAt: null,
      state: 'applied',
    });
  });

  test('a failed cleared marker leaves the old key and setting in place', async () => {
    const project = await seedProject();
    expect((await setMode(project.id, 'off')).status).toBe(200);
    const put = env.ROUTING.put.bind(env.ROUTING);
    vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      ...rest: [string, KVNamespacePutOptions?]
    ) => {
      if (key === aiLoggingClearedKey(project.id)) {
        throw new Error('KV unavailable');
      }
      return put(key, ...rest);
    }) as never);
    const response = await setMode(project.id, 'inherit');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'ai_logging_publish_pending' });
    expect((await published(project.id)).value).toBe('off');
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      effective: 'inherit',
      published: 'off',
      state: 'drift',
    });
  });

  test('a hand-edited key shows drift', async () => {
    const project = await seedProject();
    expect((await setMode(project.id, 'off')).status).toBe(200);
    await env.ROUTING.put(aiLoggingKey(project.id), 'full');
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      effective: 'off',
      published: 'full',
      state: 'drift',
    });
    // The same value without publish metadata did not come from the platform.
    await env.ROUTING.put(aiLoggingKey(project.id), 'off');
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      published: 'off',
      state: 'drift',
    });
    await env.ROUTING.put(aiLoggingKey(project.id), 'bogus');
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      published: null,
      state: 'drift',
    });
  });

  // Hosted Hyperdrive can answer a plain read from a copy up to a minute old, while
  // the key read is fresh. A cached row from before a change next to the new key
  // would read as drift, so readback must not use a cacheable read for its inputs.
  test('reads its inputs through write statements and the key under the project lock', async () => {
    const project = await seedProject();
    expect((await setMode(project.id, 'off')).status).toBe(200);
    const { result, queries } = await captureQueries(env.db, () =>
      readProjectAiLoggingStatus(env.db, env.ROUTING, project.id, 'free'),
    );
    expect(result).toMatchObject({
      mode: 'off',
      effective: 'off',
      published: 'off',
      state: 'pending',
    });
    expect(result).not.toHaveProperty('status');
    const statements = queries.map((query) => query.trim().split(' ')[0]!.toLowerCase());
    expect(statements).not.toContain('select');
    expect(statements.filter((statement) => statement === 'update')).toHaveLength(2);
    expect(
      await readProjectAiLoggingStatus(env.db, env.ROUTING, 'proj_000000000404', 'free'),
    ).toBeNull();
  });

  test('a KV read failure shows unknown instead of failing project show', async () => {
    const project = await seedProject();
    vi.spyOn(env.ROUTING, 'getWithMetadata').mockRejectedValue(new Error('KV unavailable'));
    const response = await operator(`/projects/${project.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      aiLogging: { published: null, state: 'unknown' },
    });
  });
});

describe('kept 1.8.x proxy route', () => {
  async function read(projectId: string) {
    const auth = await deriveProxyInternalAuth(env.JWT_SECRET, 'ai-logging', projectId);
    return app.fetch(
      new Request(`http://localhost/internal/ai-logging/${projectId}`, {
        headers: { [PROXY_INTERNAL_AUTH_HEADER]: auth },
      }),
      env,
    );
  }

  test('answers { mode } from the published key without the uncached flag', async () => {
    const project = await seedProject();
    const inherit = await read(project.id);
    expect(inherit.status).toBe(200);
    expect(inherit.headers.get('Cache-Control')).toContain('no-store');
    expect(await inherit.json()).toEqual({ mode: 'inherit' });
    expect((await setMode(project.id, 'metadata')).status).toBe(200);
    expect(await (await read(project.id)).json()).toEqual({ mode: 'metadata' });
  });

  test('refuses a value it does not know and a failed read', async () => {
    const project = await seedProject();
    await env.ROUTING.put(aiLoggingKey(project.id), 'bogus');
    const invalid = await read(project.id);
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toEqual({ error: 'ai_logging_policy_invalid' });
    vi.spyOn(env.ROUTING, 'get').mockRejectedValue(new Error('KV unavailable'));
    const unavailable = await read(project.id);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'ai_logging_policy_unavailable' });
  });
});

describe('project create', () => {
  async function create(owner: { jwt: string }, slug: string) {
    return app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      }),
      env,
    );
  }

  test('publishes the plan default inside the create transaction', async () => {
    mockCfApi();
    await setPlatformSetting(env.db, PLAN_AI_LOGGING_SETTING, { modes: { free: 'off' } });
    const owner = await createTestUser(env.db, 'creator');
    const response = await create(owner, 'logged-app');
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(await published(id)).toMatchObject({ value: 'off', metadata: { mode: 'off' } });
  });

  test('takes the plan lock shared before it inserts the project', async () => {
    mockCfApi();
    const owner = await createTestUser(env.db, 'creator');
    const { queries } = await captureQueries(env.db, () => create(owner, 'locked-app'));
    const lower = queries.map((query) => query.toLowerCase());
    const lock = lower.findIndex((query) => query.includes('pg_advisory_xact_lock_shared'));
    const insert = lower.findIndex((query) => query.startsWith('insert into "projects"'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(lock);
  });

  // Needs real PostgreSQL: PGlite runs one connection, so nothing ever waits on a lock.
  test.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'a user plan change waits for a project create and then publishes it',
    async () => {
      await setPlatformSetting(env.db, PLAN_AI_LOGGING_SETTING, { modes: { pro: 'off' } });
      const owner = await createTestUser(env.db, 'racer', 'github', undefined, 'free');
      let release!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        release = resolve;
      });
      let read!: () => void;
      const planRead = new Promise<void>((resolve) => {
        read = resolve;
      });
      const creating = env.db.transaction(async (tx) => {
        await lockNewProjectAiLoggingInputs(tx);
        const created = await createProject(tx, owner.id, 'racing-app');
        const result = await publishProjectAiLogging(tx, env.ROUTING, created.id, {
          trigger: 'project_create',
          initialPlanDefault: 'free',
          creating: true,
        });
        // free inherits, so the create writes nothing.
        expect(result).toMatchObject({ effective: 'inherit', at: null });
        read();
        await mayCommit;
        return created;
      });
      // Racing the create shows its own error at once if it fails before it signals.
      await Promise.race([planRead, creating]);
      let changed = false;
      const change = Promise.resolve(operator(`/users/${owner.id}/plan`, { plan: 'pro' })).then(
        (response) => {
          changed = true;
          return response;
        },
      );
      let created: Awaited<typeof creating>;
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(changed).toBe(false);
      } finally {
        // Never leave the lock held for the tests that follow.
        release();
        created = await creating;
      }
      expect((await change).status).toBe(200);
      expect((await published(created.id)).value).toBe('off');
    },
  );

  test('writes nothing for an inherit plan', async () => {
    mockCfApi();
    const owner = await createTestUser(env.db, 'creator');
    const put = vi.spyOn(env.ROUTING, 'put');
    const remove = vi.spyOn(env.ROUTING, 'delete');
    const response = await create(owner, 'plain-app');
    expect(response.status).toBe(201);
    const keys = [...put.mock.calls, ...remove.mock.calls].map(([key]) => key);
    expect(keys.filter((key) => key.startsWith('ai-logging:'))).toEqual([]);
  });

  test('a KV failure leaves no project and a retry succeeds', async () => {
    mockCfApi();
    await setPlatformSetting(env.db, PLAN_AI_LOGGING_SETTING, { modes: { free: 'off' } });
    const owner = await createTestUser(env.db, 'creator');
    const failing = failAiLoggingWrites('put');
    const response = await create(owner, 'retry-app');
    expect(response.status).toBe(503);
    expect(await env.db.select().from(projects).where(eq(projects.slug, 'retry-app'))).toEqual([]);
    failing.mockRestore();
    expect((await create(owner, 'retry-app')).status).toBe(201);
  });
});
