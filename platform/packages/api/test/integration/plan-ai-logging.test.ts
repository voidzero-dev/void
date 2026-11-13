import { createDefaultPlanCatalog, parsePlatformPlanCatalog } from '@void/platform/plans';
import { eq, inArray } from 'drizzle-orm';
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
  accountAiLoggingCandidates,
  PLAN_AI_LOGGING_PAGE_SIZE,
  runPlanAiLoggingPublishPage,
  runUserAiLoggingPublishPage,
  startPlanAiLoggingPublish,
  startUserAiLoggingPublish,
} from '../../src/ai-logging-plans.ts';
import {
  AI_LOGGING_ORPHAN_GRACE_MS,
  aiLoggingClearedKey,
  aiLoggingKey,
  PLAN_AI_LOGGING_SETTING,
  type PlanAiLoggingSettings,
} from '../../src/ai-logging-policy.ts';
import {
  AI_LOGGING_SWEEP_KV_BUDGET,
  AI_LOGGING_SWEEP_STATUS_PAGE,
  sweepAiLogging,
} from '../../src/ai-logging-sweep.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { PLAN_CATALOG_SETTING, readPlanCatalog, writePlanCatalog } from '../../src/plans.ts';
import { getPlatformSetting, setPlatformSetting } from '../../src/platform-settings.ts';
import { projectAiLogging, projects } from '../../src/schema.ts';
import {
  captureQueries,
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

// Hosted Void Cloud does not set PLATFORM_AUTH_DATABASE_UNCACHED. Nothing here may
// depend on it.
let env: TestEnv;
let token: string;
let logins = 0;

beforeAll(async () => {
  env = await setupEnv({ authDatabaseUncached: false });
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  for (const prefix of ['ai-logging:', 'ai-logging-cleared:']) {
    // Deleting while listing shifts later pages, so list the first page until empty.
    for (let page = await env.ROUTING.list({ prefix }); page.keys.length;) {
      for (const { name } of page.keys) {
        await env.ROUTING.delete(name);
      }
      page = await env.ROUTING.list({ prefix });
    }
  }
  const admin = await createTestUser(env.db, 'plan-admin', 'github', undefined, 'free', 'admin');
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

/** Previews a plan change, then applies it with the preview's revision. */
async function planChange(
  path: string,
  body: Record<string, unknown>,
  overrides?: Partial<ApiEnv['Bindings']>,
) {
  const preview = await operator(`/config/plans${path}`, { ...body, dryRun: true }, overrides);
  expect(preview.status).toBe(200);
  const { expectedRevision } = (await preview.json()) as { expectedRevision: number };
  return operator(`/config/plans${path}`, { ...body, expectedRevision }, overrides);
}

async function sync(overrides?: Partial<ApiEnv['Bindings']>) {
  const { catalog } = (await (await operator('/config/plans')).json()) as {
    catalog: { revision: number };
  };
  return operator('/config/plans/sync', { expectedRevision: catalog.revision }, overrides);
}

/**
 * Runs `plans sync` until the publish is complete.
 * Fails after `limit` calls, so a cursor that stops moving fails fast instead of
 * spinning until the test timeout.
 */
async function syncUntilComplete(limit: number): Promise<void> {
  for (let calls = 1; calls <= limit; calls++) {
    const body = (await (await sync()).json()) as { aiLoggingPublish: { complete: boolean } };
    if (body.aiLoggingPublish.complete) {
      return;
    }
  }
  throw new Error(`plan publish not complete after ${limit} sync calls`);
}

async function owner(plan: string) {
  return createTestUser(env.db, `plan-owner-${++logins}`, 'github', undefined, plan);
}

async function seedProject(plan: string) {
  const user = await owner(plan);
  return { user, project: await createTestProject(env.db, user.id) };
}

/** Bulk projects for one owner, so paging tests do not pay one insert per project. */
async function seedProjects(userId: string, count: number, prefix = 'bulk') {
  const values = Array.from({ length: count }, (_, index) => ({
    id: `proj_${prefix}${String(index).padStart(8, '0')}`,
    user_id: userId,
    slug: `${prefix}-${index}`,
  }));
  await env.db.insert(projects).values(values);
  return values.map((value) => value.id);
}

async function published(projectId: string) {
  return (await env.ROUTING.getWithMetadata(aiLoggingKey(projectId))).value;
}

async function planDefaults() {
  return getPlatformSetting(env.db, PLAN_AI_LOGGING_SETTING);
}

/**
 * The test database, but `hook` runs once before the first transaction that starts
 * after `arm()`, while no transaction of the caller is open.
 */
function hookNextTransaction(hook: () => Promise<void>) {
  let armed = false;
  const db = new Proxy(env.db, {
    get(target, property) {
      if (property === 'transaction') {
        return async (...args: Parameters<typeof target.transaction>) => {
          if (armed) {
            armed = false;
            await hook();
          }
          return target.transaction(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, arm: () => (armed = true) };
}

/** Starts a plan publish whose first page failed, so its cursor is still null. */
async function stalledPlanPublish(path: string, body: Record<string, unknown>) {
  const failing = failAiLoggingWrites('put');
  expect((await planChange(path, body)).status).toBe(200);
  failing.mockRestore();
  return (await planDefaults()) as PlanAiLoggingSettings;
}

/** Runs one publish page; `during` commits while the page is between projects. */
async function pageWithConcurrentChange(during: () => Promise<void>) {
  const hooked = hookNextTransaction(during);
  const put = env.ROUTING.put.bind(env.ROUTING);
  const spy = vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
    key: string,
    ...rest: [string, KVNamespacePutOptions?]
  ) => {
    // After the first project's write, the next transaction is the second project's.
    if (key.startsWith('ai-logging:') && spy.mock.calls.length === 1) {
      hooked.arm();
    }
    return put(key, ...rest);
  }) as never);
  try {
    return await runPlanAiLoggingPublishPage(hooked.db, env.ROUTING, 'free');
  } finally {
    spy.mockRestore();
  }
}

/** Fails ROUTING writes to AI logging keys only; other keys keep working. */
function failAiLoggingWrites(method: 'put' | 'delete') {
  const original = env.ROUTING[method].bind(env.ROUTING) as (...args: Array<unknown>) => unknown;
  return vi.spyOn(env.ROUTING, method).mockImplementation((async (
    key: string,
    ...rest: Array<unknown>
  ) => {
    if (key.startsWith('ai-logging:')) {
      throw new Error('KV unavailable');
    }
    return original(key, ...rest);
  }) as never);
}

function aiLoggingWrites() {
  const put = vi.spyOn(env.ROUTING, 'put');
  const remove = vi.spyOn(env.ROUTING, 'delete');
  return () =>
    [...put.mock.calls, ...remove.mock.calls]
      .map(([key]) => key)
      .filter((key) => key.startsWith('ai-logging:'));
}

/** A usage counter that fails every call, to prove a path never reaches it. */
function forbiddenUsageCounter() {
  const get = vi.fn(() => {
    throw new Error('usage counter must not be called');
  });
  return { get, namespace: { idFromName: (name: string) => name, get } as never };
}

describe('plan routes', () => {
  test('set with only aiLogging saves and publishes it; inherit clears; leaving it out keeps it', async () => {
    const { project } = await seedProject('free');
    const before = await readPlanCatalog(env.db);

    const set = await planChange('/free/set', { aiLogging: 'off' });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      ok: true,
      // free is the default plan, so accounts on unknown plans follow it too.
      aiLogging: { modes: { free: 'off' }, planIds: ['free'], includeUnknown: true },
      aiLoggingPublish: { complete: true, processed: 1, remaining: 0 },
    });
    expect((await readPlanCatalog(env.db)).revision).toBe(before.revision + 1);
    expect(await published(project.id)).toBe('off');
    expect(await (await operator('/config/plans/free')).json()).toMatchObject({
      aiLogging: 'off',
    });
    expect(await (await operator(`/projects/${project.id}/ai-logging`)).json()).toMatchObject({
      mode: 'inherit',
      effective: 'off',
      source: 'plan',
      state: 'pending',
    });

    const writes = aiLoggingWrites();
    expect((await planChange('/free/set', { name: 'Free tier' })).status).toBe(200);
    expect(await planDefaults()).toMatchObject({ modes: { free: 'off' } });
    expect(writes()).toEqual([]);

    expect((await planChange('/free/set', { aiLogging: 'inherit' })).status).toBe(200);
    expect(await planDefaults()).toMatchObject({ modes: {} });
    expect(await published(project.id)).toBeNull();
    expect(await (await operator('/config/plans/free')).json()).toMatchObject({
      aiLogging: 'inherit',
    });
  });

  test('the preview counts the projects a change will publish', async () => {
    const pro = await owner('pro');
    const ids = await seedProjects(pro.id, 3, 'pro');
    await env.db.insert(projectAiLogging).values({ project_id: ids[0]!, mode: 'full' });
    await seedProject('free');
    const preview = await operator('/config/plans/pro/set', { aiLogging: 'off', dryRun: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      aiLogging: { planIds: ['pro'] },
      aiLoggingPublish: { complete: false, processed: 0, remaining: 2 },
    });
    expect(await planDefaults()).toBeNull();

    // A change that moves no default publishes nothing.
    const rename = await operator('/config/plans/pro/set', { name: 'Pro+', dryRun: true });
    expect(await rename.json()).toMatchObject({
      aiLoggingPublish: { complete: true, remaining: 0 },
    });
  });

  test('the preview of a plan removal counts the accounts it moves', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    expect((await planChange('/add', { id: 'team', copyFrom: 'free', name: 'Team' })).status).toBe(
      200,
    );
    await seedProject('pro');
    await seedProject('pro');
    const preview = await operator('/config/plans/pro/remove', {
      replacementPlanId: 'team',
      dryRun: true,
    });
    expect(await preview.json()).toMatchObject({
      aiLogging: { planIds: ['team'] },
      aiLoggingPublish: { complete: false, remaining: 2 },
    });
  });

  test('refuses an unknown mode and aiLogging on actions that cannot set it', async () => {
    const bad = await operator('/config/plans/free/set', { aiLogging: 'bogus', dryRun: true });
    expect(bad.status).toBe(400);
    const archive = await operator('/config/plans/pro/archive', {
      aiLogging: 'off',
      dryRun: true,
    });
    expect(archive.status).toBe(400);
    expect(await planDefaults()).toBeNull();
  });

  test('add copies the source default and remove drops it', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'metadata' })).status).toBe(200);
    const added = await planChange('/add', { id: 'team', copyFrom: 'pro', name: 'Team' });
    expect(added.status).toBe(200);
    expect(await planDefaults()).toMatchObject({ modes: { pro: 'metadata', team: 'metadata' } });
    const own = await planChange('/add', {
      id: 'lab',
      copyFrom: 'pro',
      name: 'Lab',
      aiLogging: 'off',
    });
    expect(own.status).toBe(200);
    expect(await planDefaults()).toMatchObject({ modes: { lab: 'off' } });
    expect((await planChange('/team/remove', {})).status).toBe(200);
    const { modes } = (await planDefaults()) as { modes: Record<string, string> };
    expect(modes).toEqual({ pro: 'metadata', lab: 'off' });
  });

  test('publishes in pages of 100 through sync, without the usage counter', async () => {
    const user = await owner('pro');
    const ids = await seedProjects(user.id, 250);
    // A project with its own setting keeps it and is not part of the fan-out.
    await env.db.insert(projectAiLogging).values({ project_id: ids[0]!, mode: 'full' });
    const counter = forbiddenUsageCounter();
    const overrides = { USAGE_COUNTER: counter.namespace };

    const first = await planChange('/pro/set', { aiLogging: 'off' }, overrides);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      aiLoggingPublish: {
        complete: false,
        processed: PLAN_AI_LOGGING_PAGE_SIZE,
        remaining: 249 - PLAN_AI_LOGGING_PAGE_SIZE,
      },
    });
    const last = ids.at(-1)!;
    expect(await published(last)).toBeNull();
    expect(await (await operator(`/projects/${last}/ai-logging`)).json()).toMatchObject({
      effective: 'off',
      state: 'pending_plan_publish',
    });
    expect(await (await operator('/config/plans/pro')).json()).toMatchObject({
      aiLoggingPublish: { complete: false, remaining: 149 },
    });

    expect(await (await sync(overrides)).json()).toMatchObject({
      ok: true,
      aiLoggingPublish: { complete: false, processed: 100, remaining: 49 },
    });
    expect(await (await sync(overrides)).json()).toMatchObject({
      ok: true,
      aiLoggingPublish: { complete: true, processed: 49, remaining: 0 },
    });
    expect(await published(last)).toBe('off');
    expect(await published(ids[0]!)).toBeNull();
    expect(await (await operator(`/projects/${last}/ai-logging`)).json()).toMatchObject({
      state: 'pending',
    });
    expect(counter.get).not.toHaveBeenCalled();
  });

  test('a failed page keeps the publish pending and the next sync continues', async () => {
    const user = await owner('pro');
    const [first] = await seedProjects(user.id, 3);
    const failing = failAiLoggingWrites('put');
    const response = await planChange('/pro/set', { aiLogging: 'off' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      aiLoggingPublish: { complete: false, processed: 0, error: expect.any(String) },
    });
    expect(await planDefaults()).toMatchObject({
      modes: { pro: 'off' },
      publish: { complete: false, cursor: null, error: expect.any(String) },
    });
    failing.mockRestore();
    expect(await (await sync()).json()).toMatchObject({
      ok: true,
      aiLoggingPublish: { complete: true, processed: 3 },
    });
    expect(await published(first!)).toBe('off');
    expect(await planDefaults()).toMatchObject({ publish: { complete: true } });
  });

  test('a newer plan change restarts a running publish with every plan it covers', async () => {
    const pro = await owner('pro');
    const free = await owner('free');
    const proIds = await seedProjects(pro.id, 150, 'pro');
    const [freeId] = await seedProjects(free.id, 1, 'free');
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    // pro still has 50 projects to go; a free change folds into the same run.
    const second = await planChange('/free/set', { aiLogging: 'metadata' });
    expect(await second.json()).toMatchObject({ aiLoggingPublish: { complete: false } });
    expect(await planDefaults()).toMatchObject({
      publish: { planIds: ['free', 'pro'], complete: false },
    });
    await syncUntilComplete(5);
    expect(await published(proIds.at(-1)!)).toBe('off');
    expect(await published(freeId!)).toBe('metadata');
  });

  test('a page that ends after a newer plan change leaves the newer run alone', async () => {
    const pro = await owner('pro');
    const free = await owner('free');
    const proIds = await seedProjects(pro.id, 150, 'pro');
    const [freeId] = await seedProjects(free.id, 1, 'free');
    const stalled = await stalledPlanPublish('/pro/set', { aiLogging: 'off' });
    const newer: PlanAiLoggingSettings = {
      modes: { ...stalled.modes, free: 'metadata' },
      publish: startPlanAiLoggingPublish(stalled.publish, stalled.publish!.revision + 1, {
        planIds: ['free'],
        includeUnknown: false,
      }),
    };

    const page = await pageWithConcurrentChange(() =>
      setPlatformSetting(env.db, PLAN_AI_LOGGING_SETTING, newer),
    );
    expect(page).toMatchObject({ complete: false, processed: PLAN_AI_LOGGING_PAGE_SIZE });
    // The old page must not move the newer run's cursor past the free project.
    expect(await planDefaults()).toEqual(newer);
    await syncUntilComplete(5);
    expect(await published(freeId!)).toBe('metadata');
    expect(await published(proIds.at(-1)!)).toBe('off');
  });

  test('a page never moves the cursor back behind a call that went further', async () => {
    const pro = await owner('pro');
    const ids = await seedProjects(pro.id, 150, 'pro');
    const stalled = await stalledPlanPublish('/pro/set', { aiLogging: 'off' });
    const ahead = ids[120]!;

    await pageWithConcurrentChange(async () => {
      const current = (await planDefaults()) as PlanAiLoggingSettings;
      await setPlatformSetting(env.db, PLAN_AI_LOGGING_SETTING, {
        ...current,
        publish: { ...current.publish!, cursor: ahead },
      });
    });
    expect(await planDefaults()).toMatchObject({
      publish: { revision: stalled.publish!.revision, cursor: ahead, complete: false },
    });
  });

  test('a page reads the running publish through a write, not a cacheable read', async () => {
    const user = await owner('pro');
    const [id] = await seedProjects(user.id, 1);
    await stalledPlanPublish('/pro/set', { aiLogging: 'off' });
    const { result, queries } = await captureQueries(env.db, () =>
      runPlanAiLoggingPublishPage(env.db, env.ROUTING, 'free'),
    );
    expect(result).toMatchObject({ complete: true, processed: 1 });
    expect(await published(id!)).toBe('off');
    const settingsReads = queries.filter((query) => query.includes('"platform_settings"'));
    expect(settingsReads.length).toBeGreaterThan(0);
    for (const query of settingsReads) {
      expect(query.trim().split(' ')[0]!.toLowerCase()).not.toBe('select');
    }
  });

  test('a plan change reads the catalog it builds on through a write, not a cacheable read', async () => {
    // The new catalog revision names the publish run, so a cached older revision
    // would give two plan changes the same run.
    const preview = await operator('/config/plans/pro/set', { aiLogging: 'off', dryRun: true });
    const { expectedRevision } = (await preview.json()) as { expectedRevision: number };
    const { result, queries } = await captureQueries(env.db, async () =>
      operator('/config/plans/pro/set', { aiLogging: 'off', expectedRevision }),
    );
    expect(result.status).toBe(200);
    const settingsQueries = queries.filter((query) => query.includes('"platform_settings"'));
    expect(settingsQueries.length).toBeGreaterThan(0);
    for (const query of settingsQueries) {
      expect(query.trim().split(' ')[0]!.toLowerCase()).not.toBe('select');
    }
  });

  test('a default plan change republishes accounts whose plan is not in the catalog', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    const legacy = await seedProject('legacy-x');
    const onFree = await seedProject('free');
    const writes = aiLoggingWrites();
    const response = await planChange('/default', { planId: 'pro' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      aiLogging: { planIds: [], includeUnknown: true },
      aiLoggingPublish: { complete: true, processed: 1 },
    });
    expect(await published(legacy.project.id)).toBe('off');
    expect(writes()).toEqual([aiLoggingKey(legacy.project.id)]);
    expect(await published(onFree.project.id)).toBeNull();
  });

  test('removing a plan publishes the replacement default to the moved accounts', async () => {
    const moved = await seedProject('pro');
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    expect(await published(moved.project.id)).toBe('off');
    expect((await planChange('/add', { id: 'team', copyFrom: 'free', name: 'Team' })).status).toBe(
      200,
    );

    const removed = await planChange('/pro/remove', { replacementPlanId: 'team' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      aiLogging: { planIds: ['team'] },
      aiLoggingPublish: { complete: true, processed: 1 },
    });
    expect(await published(moved.project.id)).toBeNull();
    expect(await planDefaults()).toMatchObject({ modes: {} });
  });

  test('an old-style catalog write leaves plan defaults intact', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'metadata' })).status).toBe(200);
    // Older APIs rebuild the catalog from known keys and save it on every write.
    const catalog = await readPlanCatalog(env.db);
    await writePlanCatalog(env.db, parsePlatformPlanCatalog(JSON.parse(JSON.stringify(catalog))));
    await setPlatformSetting(env.db, PLAN_CATALOG_SETTING, {
      ...createDefaultPlanCatalog('free'),
      revision: catalog.revision + 1,
    });
    expect(await planDefaults()).toMatchObject({ modes: { pro: 'metadata' } });
    expect(await (await operator('/config/plans/pro')).json()).toMatchObject({
      aiLogging: 'metadata',
    });
  });
});

describe('account changes', () => {
  test('a user plan change publishes before the counter calls, even when they fail', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    const { user, project } = await seedProject('free');
    const response = await operator(
      `/users/${user.id}/plan`,
      { plan: 'pro' },
      {
        USAGE_COUNTER: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response('down', { status: 500 }) }),
        } as never,
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'partial_failure',
      message: expect.stringContaining('cleanup incomplete'),
    });
    expect(await published(project.id)).toBe('off');
  });

  test('a user plan change reports a failed AI logging publish and still reconciles limits', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    const { user, project } = await seedProject('free');
    const get = vi.spyOn(env.USAGE_COUNTER, 'get');
    failAiLoggingWrites('put');
    const response = await operator(`/users/${user.id}/plan`, { plan: 'pro' });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: 'partial_failure',
      message:
        'Plan changed, but the AI logging setting may not be applied yet. Retry the plan change.',
      details: { aiLoggingComplete: false, cleanupComplete: true },
    });
    expect(await published(project.id)).toBeNull();
    expect(get).toHaveBeenCalled();
  });

  test('a large account publishes one page per call, and the same change continues it', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    const user = await owner('free');
    const ids = await seedProjects(user.id, PLAN_AI_LOGGING_PAGE_SIZE + 20);
    const get = vi.spyOn(env.USAGE_COUNTER, 'get');
    let writes = aiLoggingWrites();
    const first = await operator(`/users/${user.id}/plan`, { plan: 'pro' });
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({
      error: 'partial_failure',
      message: `Plan changed. AI logging was published to ${PLAN_AI_LOGGING_PAGE_SIZE} projects; 20 remain. Run the same plan change again to continue.`,
      details: { aiLoggingComplete: false, aiLoggingRemaining: 20, cleanupComplete: true },
    });
    // Limits follow the new plan at once, before the last page.
    expect(get).toHaveBeenCalled();
    expect(writes()).toHaveLength(PLAN_AI_LOGGING_PAGE_SIZE);
    expect(await published(ids[PLAN_AI_LOGGING_PAGE_SIZE - 1]!)).toBe('off');
    expect(await published(ids.at(-1)!)).toBeNull();
    // A project the unfinished change has not reached yet is pending, not drift.
    expect(await (await operator(`/projects/${ids.at(-1)!}/ai-logging`)).json()).toMatchObject({
      effective: 'off',
      published: 'inherit',
      state: 'pending_plan_publish',
    });

    vi.restoreAllMocks();
    writes = aiLoggingWrites();
    const second = await operator(`/users/${user.id}/plan`, { plan: 'pro' });
    expect(second.status).toBe(200);
    // Only the rest: the retry does not start again from the first project.
    expect(writes()).toEqual(ids.slice(PLAN_AI_LOGGING_PAGE_SIZE).map(aiLoggingKey));
    expect(await published(ids.at(-1)!)).toBe('off');
    expect(await getPlatformSetting(env.db, `ai-logging:user-publish:${user.id}`)).toBeNull();

    // Once finished, the same change publishes every project again.
    vi.restoreAllMocks();
    writes = aiLoggingWrites();
    expect((await operator(`/users/${user.id}/plan`, { plan: 'pro' })).status).toBe(500);
    expect(writes()).toEqual(ids.slice(0, PLAN_AI_LOGGING_PAGE_SIZE).map(aiLoggingKey));
  });

  test('a change to another plan starts again from the first project', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    expect((await planChange('/solo/set', { aiLogging: 'metadata' })).status).toBe(200);
    const user = await owner('free');
    const ids = await seedProjects(user.id, PLAN_AI_LOGGING_PAGE_SIZE + 5);
    expect((await operator(`/users/${user.id}/plan`, { plan: 'pro' })).status).toBe(500);
    expect(await published(ids[0]!)).toBe('off');
    const writes = aiLoggingWrites();
    expect((await operator(`/users/${user.id}/plan`, { plan: 'solo' })).status).toBe(500);
    expect(writes()[0]).toBe(aiLoggingKey(ids[0]!));
    expect(await published(ids[0]!)).toBe('metadata');
    expect((await operator(`/users/${user.id}/plan`, { plan: 'solo' })).status).toBe(200);
    for (const id of ids) {
      expect(await published(id)).toBe('metadata');
    }
  });

  test('a page for a plan the account has left does nothing', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    const { user, project } = await seedProject('free');
    await env.db.transaction((tx) => startUserAiLoggingPublish(tx, user.id, 'free', 'pro'));
    // A newer change to solo took over before the pro page ran.
    await env.db.transaction((tx) => startUserAiLoggingPublish(tx, user.id, 'pro', 'solo'));
    const writes = aiLoggingWrites();
    expect(
      await runUserAiLoggingPublishPage(env.db, env.ROUTING, user.id, 'pro', {
        initialPlanDefault: 'free',
      }),
    ).toMatchObject({ complete: true, processed: 0 });
    expect(writes()).toEqual([]);
    expect(await published(project.id)).toBeNull();
  });

  test('a page from an earlier change to the same plan leaves the newer run alone', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    const { user, project } = await seedProject('pro');
    await env.db.transaction((tx) => startUserAiLoggingPublish(tx, user.id, 'free', 'pro'));
    const hooked = hookNextTransaction(async () => {
      // pro -> solo -> pro while the first pro page is still running.
      await env.db.transaction((tx) => startUserAiLoggingPublish(tx, user.id, 'pro', 'solo'));
      await env.db.transaction((tx) => startUserAiLoggingPublish(tx, user.id, 'solo', 'pro'));
    });
    const put = env.ROUTING.put.bind(env.ROUTING);
    const spy = vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      ...rest: [string, KVNamespacePutOptions?]
    ) => {
      // The next transaction is the page's last one, which saves its progress.
      if (key.startsWith('ai-logging:')) {
        hooked.arm();
      }
      return put(key, ...rest);
    }) as never);
    const options = { initialPlanDefault: 'free' } as const;
    expect(
      await runUserAiLoggingPublishPage(hooked.db, env.ROUTING, user.id, 'pro', options),
    ).toMatchObject({ processed: 1 });
    spy.mockRestore();
    // The newer run still starts from the first project.
    expect(await getPlatformSetting(env.db, `ai-logging:user-publish:${user.id}`)).toMatchObject({
      plan: 'pro',
      cursor: null,
    });
    expect(
      await runUserAiLoggingPublishPage(env.db, env.ROUTING, user.id, 'pro', options),
    ).toMatchObject({ complete: true, processed: 1 });
    expect(await published(project.id)).toBe('off');
  });

  test('a user plan change publishes every project without an override, even when both plans inherit', async () => {
    const { user, project } = await seedProject('free');
    const own = await createTestProject(env.db, user.id);
    await env.db.insert(projectAiLogging).values({ project_id: own.id, mode: 'full' });
    // A key left from an earlier plan default.
    await env.ROUTING.put(aiLoggingKey(project.id), 'off', { metadata: { mode: 'off', at: 1 } });
    const writes = aiLoggingWrites();
    expect((await operator(`/users/${user.id}/plan`, { plan: 'pro' })).status).toBe(200);
    expect(writes()).toEqual([aiLoggingKey(project.id)]);
    expect(await published(project.id)).toBeNull();
  });

  test('retrying a failed user plan change removes the old plan default', async () => {
    const { user, project } = await seedProject('pro');
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    expect(await published(project.id)).toBe('off');
    const failing = failAiLoggingWrites('delete');
    const failed = await operator(`/users/${user.id}/plan`, { plan: 'free' });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: 'partial_failure' });
    expect(await published(project.id)).toBe('off');
    failing.mockRestore();
    // The plan is already saved, so the retry moves free -> free.
    const retried = await operator(`/users/${user.id}/plan`, { plan: 'free' });
    expect(retried.status).toBe(200);
    expect(await published(project.id)).toBeNull();
  });

  test('a user plan change lists its projects through a write, not a cacheable read', async () => {
    const { user, project } = await seedProject('free');
    const { result, queries } = await captureQueries(env.db, () =>
      accountAiLoggingCandidates(env.db, user.id),
    );
    expect(result).toEqual([project.id]);
    expect(queries.map((query) => query.trim().split(' ')[0]!.toLowerCase())).toEqual(['update']);
    // The subquery takes the row locks in id order, like the installer projection.
    expect(queries[0]).toContain('order by "projects"."id" asc for no key update of "projects"');
  });

  test('an ownership transfer publishes the project once', async () => {
    expect((await planChange('/pro/set', { aiLogging: 'metadata' })).status).toBe(200);
    const { project } = await seedProject('free');
    const target = await owner('pro');
    const writes = aiLoggingWrites();
    const response = await operator(`/projects/${project.id}/owner`, { userId: target.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      convergence: { aiLoggingComplete: true, routingComplete: true },
    });
    expect(writes()).toEqual([aiLoggingKey(project.id)]);
    expect(await published(project.id)).toBe('metadata');
  });

  test('a failed publish during an ownership transfer is a partial failure; a retry publishes', async () => {
    const { project } = await seedProject('free');
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    expect((await planChange('/free/set', { aiLogging: 'full' })).status).toBe(200);
    expect(await published(project.id)).toBe('full');
    const target = await owner('pro');
    const failing = failAiLoggingWrites('put');
    const failed = await operator(`/projects/${project.id}/owner`, { userId: target.id });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      error: 'partial_failure',
      details: {
        ownershipTransferred: true,
        convergence: { aiLoggingComplete: false, routingComplete: true },
      },
    });
    expect(await published(project.id)).toBe('full');
    failing.mockRestore();
    const retried = await operator(`/projects/${project.id}/owner`, { userId: target.id });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ convergence: { aiLoggingComplete: true } });
    expect(await published(project.id)).toBe('off');
  });
});

describe('hourly sweep', () => {
  test('repairs a mismatch, leaves matching keys alone and removes orphan keys', async () => {
    const matching = await seedProject('pro');
    const wrong = await seedProject('pro');
    const missing = await seedProject('pro');
    const nowInherit = await seedProject('free');
    // Publish the expected keys, then damage some of them.
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    await env.ROUTING.put(aiLoggingKey(wrong.project.id), 'full', {
      metadata: { mode: 'full', at: Date.now() },
    });
    await env.ROUTING.delete(aiLoggingKey(missing.project.id));
    await env.ROUTING.put(aiLoggingKey(nowInherit.project.id), 'off', {
      metadata: { mode: 'off', at: Date.now() },
    });
    const old = Date.now() - AI_LOGGING_ORPHAN_GRACE_MS - 1;
    await env.ROUTING.put(aiLoggingKey('proj_gone0000001'), 'off', {
      metadata: { mode: 'off', at: old },
    });
    await env.ROUTING.put(aiLoggingKey('proj_young000001'), 'off', {
      metadata: { mode: 'off', at: Date.now() },
    });
    const writes = aiLoggingWrites();

    const result = await sweepAiLogging(env.db, env.ROUTING, 'free');
    expect(result).toEqual({ listed: 5, expected: 3, mismatched: 4, repaired: 4 });
    expect(writes().sort()).toEqual(
      [
        aiLoggingKey(wrong.project.id),
        aiLoggingKey(missing.project.id),
        aiLoggingKey(nowInherit.project.id),
        aiLoggingKey('proj_gone0000001'),
      ].sort(),
    );
    expect(await published(matching.project.id)).toBe('off');
    expect(await published(wrong.project.id)).toBe('off');
    expect(await published(missing.project.id)).toBe('off');
    expect(await published(nowInherit.project.id)).toBeNull();
    expect(await published('proj_gone0000001')).toBeNull();
    // A create writes its key before it commits; a young key may still get its row.
    expect(await published('proj_young000001')).toBe('off');

    expect(await sweepAiLogging(env.db, env.ROUTING, 'free')).toMatchObject({ mismatched: 0 });
  });

  test('follows the KV list cursor past the first 1000 keys', async () => {
    const user = await owner('free');
    const ids = await seedProjects(user.id, 1100);
    await env.db
      .insert(projectAiLogging)
      .values(ids.map((id) => ({ project_id: id, mode: 'off' as const })));
    for (const id of ids) {
      await env.ROUTING.put(aiLoggingKey(id), 'off', { metadata: { mode: 'off', at: 1 } });
    }
    // Sorts after every project key, so it is on the second list page.
    const gone = 'proj_zzgone000001';
    await env.ROUTING.put(aiLoggingKey(gone), 'off', { metadata: { mode: 'off', at: 1 } });
    expect(await sweepAiLogging(env.db, env.ROUTING, 'free')).toEqual({
      listed: 1101,
      expected: 1100,
      mismatched: 1,
      repaired: 1,
    });
    expect(await published(gone)).toBeNull();
  });

  test('reads orphan key statuses in pages, so a long list stays inside the bind limit', async () => {
    const user = await owner('free');
    const count = AI_LOGGING_SWEEP_STATUS_PAGE + 100;
    const ids = await seedProjects(user.id, count);
    // The last 100 sit on the second status page; a project being deleted is left alone.
    const deleting = ids.slice(AI_LOGGING_SWEEP_STATUS_PAGE);
    await env.db.update(projects).set({ status: 'deleting' }).where(inArray(projects.id, deleting));
    for (const id of ids) {
      await env.ROUTING.put(aiLoggingKey(id), 'off', { metadata: { mode: 'off', at: 1 } });
    }
    const { result, queries } = await captureQueries(env.db, () =>
      sweepAiLogging(env.db, env.ROUTING, 'free', { repairLimit: 0 }),
    );
    expect(result).toEqual({
      listed: count,
      expected: 0,
      mismatched: AI_LOGGING_SWEEP_STATUS_PAGE,
      repaired: 0,
    });
    const statusReads = queries.filter((query) =>
      query.startsWith('select "id", "status" from "projects"'),
    );
    expect(statusReads).toHaveLength(2);
    for (const query of statusReads) {
      expect(query.split('$').length - 1).toBeLessThanOrEqual(AI_LOGGING_SWEEP_STATUS_PAGE);
    }
  });

  test('removing a key writes its cleared marker and costs two writes', async () => {
    const first = await seedProject('free');
    const second = await seedProject('free');
    for (const { project } of [first, second]) {
      await env.ROUTING.put(aiLoggingKey(project.id), 'off', { metadata: { mode: 'off', at: 1 } });
    }
    const [repairedId, waitingId] = [first.project.id, second.project.id].sort();
    expect(await sweepAiLogging(env.db, env.ROUTING, 'free', { repairLimit: 3 })).toMatchObject({
      mismatched: 2,
      repaired: 1,
    });
    expect(await published(repairedId!)).toBeNull();
    expect(
      (await env.ROUTING.getWithMetadata(aiLoggingClearedKey(repairedId!))).metadata,
    ).toMatchObject({ at: expect.any(Number) });
    expect(await published(waitingId!)).toBe('off');
  });

  test('a key without metadata counts as drift', async () => {
    const { project } = await seedProject('free');
    await env.db.insert(projectAiLogging).values({ project_id: project.id, mode: 'off' });
    await env.ROUTING.put(aiLoggingKey(project.id), 'off');
    expect(await sweepAiLogging(env.db, env.ROUTING, 'free')).toMatchObject({ repaired: 1 });
    expect(await env.ROUTING.getWithMetadata(aiLoggingKey(project.id))).toMatchObject({
      value: 'off',
      metadata: { mode: 'off' },
    });
  });

  test(`uses at most ${AI_LOGGING_SWEEP_KV_BUDGET} KV operations per run`, async () => {
    const user = await owner('free');
    const ids = await seedProjects(user.id, 600);
    await env.db
      .insert(projectAiLogging)
      .values(ids.map((id) => ({ project_id: id, mode: 'off' as const })));
    // One list page, then one write per repair.
    const repairs = AI_LOGGING_SWEEP_KV_BUDGET - 1;
    expect(await sweepAiLogging(env.db, env.ROUTING, 'free')).toEqual({
      listed: 0,
      expected: 600,
      mismatched: 600,
      repaired: repairs,
    });
    expect(await sweepAiLogging(env.db, env.ROUTING, 'free')).toEqual({
      listed: repairs,
      expected: 600,
      mismatched: 600 - repairs,
      repaired: 600 - repairs,
    });
    expect(await sweepAiLogging(env.db, env.ROUTING, 'free')).toMatchObject({ mismatched: 0 });
  });

  test('keeps room for the plan publish page inside the KV budget', async () => {
    const user = await owner('pro');
    const ids = await seedProjects(user.id, 150);
    const failing = failAiLoggingWrites('put');
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    failing.mockRestore();
    const other = await owner('free');
    const drifted = await seedProjects(other.id, 300, 'drift');
    await env.db
      .insert(projectAiLogging)
      .values(drifted.map((id) => ({ project_id: id, mode: 'off' as const })));
    // 400 minus one list page minus 200 kept for the plan page.
    expect(await sweepAiLogging(env.db, env.ROUTING, 'free')).toMatchObject({ repaired: 199 });
    expect(await published(ids[0]!)).toBe('off');
  });

  test('advances one page of an unfinished plan publish', async () => {
    const user = await owner('pro');
    const ids = await seedProjects(user.id, 150);
    const failing = failAiLoggingWrites('put');
    expect((await planChange('/pro/set', { aiLogging: 'off' })).status).toBe(200);
    failing.mockRestore();
    await sweepAiLogging(env.db, env.ROUTING, 'free');
    expect(await planDefaults()).toMatchObject({ publish: { complete: false } });
    await sweepAiLogging(env.db, env.ROUTING, 'free');
    expect(await planDefaults()).toMatchObject({ publish: { complete: true } });
    expect(await published(ids.at(-1)!)).toBe('off');
  });

  test('leaves the key of a project that is being deleted until its row is gone', async () => {
    const { project } = await seedProject('free');
    await env.ROUTING.put(aiLoggingKey(project.id), 'off', {
      metadata: { mode: 'off', at: 0 },
    });
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    expect(await sweepAiLogging(env.db, env.ROUTING, 'free')).toMatchObject({ mismatched: 0 });
    expect(await published(project.id)).toBe('off');
  });
});
