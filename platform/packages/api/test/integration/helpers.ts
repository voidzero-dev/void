import { PGlite } from '@electric-sql/pglite';
import { desc, eq, sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/pglite';
import pg from 'pg';
import { vi } from 'vite-plus/test';
import { signJwt } from '../../src/auth/jwt.ts';
import type { CronSyncState } from '../../src/cron-scheduler-client.ts';
import type { Db } from '../../src/db.ts';
import { generateId } from '../../src/id.ts';
import { encryptProjectSecret } from '../../src/project-secrets.ts';
import type { SandboxConcurrencyCounter } from '../../src/sandbox-concurrency-counter.ts';
import * as schema from '../../src/schema.ts';
import {
  users,
  oauthAccounts,
  projects,
  deployments,
  projectSecrets,
  resources,
  domains,
  invitations,
  oauthNonces,
  authCodes,
  operatorSessions,
  operatorEvents,
  platformSettings,
  sandboxDrainCheckpoints,
  builds,
  githubConnections,
  githubInstallations,
  githubInstallationMembers,
  githubInstallationRevocations,
  githubWebhookRedeliveries,
} from '../../src/schema.ts';
import type { PlanId } from '../../src/tiers.ts';
import type { Build, GitHubInstallationMember } from '../../src/types.ts';
import { loadPGliteTemplateBundle } from './db-template.ts';
import { setTestDb, clearTestDb } from './setup.ts';

export const JWT_SECRET = 'test-jwt-secret';
export const EMAIL_SIGNING_SECRET = 'test-email-signing-secret-independent';
export const CF_API_TOKEN = 'test-cf-token';
export const CF_ACCOUNT_ID = 'test-account-id';
export const CF_ZONE_ID = 'test-zone-id';
export const PROJECT_SECRET_ACTIVE_KEY_VERSION = '1';
export const PROJECT_SECRET_KEYS_JSON = JSON.stringify({
  [PROJECT_SECRET_ACTIVE_KEY_VERSION]: Buffer.from('0123456789abcdef0123456789abcdef').toString(
    'base64',
  ),
});

export type TestEnv = {
  db: Db & { $client: pg.Pool | PGlite };
  HYPERDRIVE: { connectionString: string };
  ISR_CACHE: KVNamespace;
  ROUTING: KVNamespace;
  STATIC_ASSETS: KVNamespace;
  STATIC_ASSETS_R2: R2Bucket;
  DISPATCH: DispatchNamespace;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  JWT_SECRET: string;
  EMAIL_SIGNING_SECRET: string;
  PLATFORM_AUTH_DATABASE_UNCACHED: string;
  PROJECT_SECRET_KEYS_JSON: string;
  PROJECT_SECRET_ACTIVE_KEY_VERSION: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_STATIC_ASSETS_BUCKET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DASHBOARD_URL?: string;
  AUTH_REDIRECT_URI?: string;
  DEV_AUTH_BYPASS?: string;
  SITE_DOMAIN?: string;
  EMAIL?: SendEmail;
  EMAIL_GATEWAY_ORIGIN?: string;
  /**
   * Platform mail zone for the environment (`mail.void.cloud` in production,
   * `mail.voidcloud.dev` in staging). Left UNSET by `setupEnv` on
   * purpose: every reader fails closed without it, and a test that wants the
   * email paths must opt in with `{ ...env, EMAIL_SENDER_DOMAIN: '...' }` so
   * the fail-closed branch stays reachable. Verification-mail tests also set
   * `EMAIL_GATEWAY_ORIGIN` explicitly.
   */
  EMAIL_SENDER_DOMAIN?: string;
  REQUESTS_DATASET?: string;
  TAIL_SERVICE_NAME?: string;
  PLATFORM_CAPABILITIES?: string;
  PLATFORM_DISPLAY_NAME?: string;
  PLATFORM_BOOTSTRAP_GITHUB_ID?: string;
  PLATFORM_INSTALLATION_ID?: string;
  PLATFORM_VERSION?: string;
  USAGE_COUNTER: DurableObjectNamespace;
  CRON_SCHEDULER: DurableObjectNamespace;
  ERROR_ALERT_MONITOR: DurableObjectNamespace;
  SANDBOX_CONCURRENCY_COUNTER: DurableObjectNamespace<SandboxConcurrencyCounter>;
  BUILD_SCHEDULER: DurableObjectNamespace;
  BUILD_MANAGER: DurableObjectNamespace;
  BUILD_MANAGER_LARGE: DurableObjectNamespace;
  /** Test-only override for the deploy handler's heartbeat interval. */
  DEPLOY_HEARTBEAT_INTERVAL_MS?: number;
};

export function createMockExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

function createMockDoNamespace(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (_id: unknown) => ({
      revokeDeployment: async () => {},
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === '/rollover') {
          return Response.json({ rolled: false });
        }
        if (url.pathname === '/init') {
          return Response.json({ ok: true });
        }
        if (url.pathname === '/state') {
          return Response.json({});
        }
        return Response.json({ totalRequests: 0, suspended: false });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

export function recordingBuildManager(options: Readonly<{ recordFetchCancel?: boolean }> = {}): {
  namespace: DurableObjectNamespace;
  cancelledIds: ReadonlyArray<string>;
} {
  const cancelledIds: Array<string> = [];
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      cancelBuild: async (_reason?: string) => {
        cancelledIds.push(id.toString());
      },
      fetch: async (input: string | URL | Request) => {
        if (options.recordFetchCancel) {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (new URL(url).pathname === '/cancel') {
            cancelledIds.push(id.toString());
          }
        }
        return Response.json({ ok: true });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, cancelledIds };
}

type StoredValue = {
  value: string | ArrayBuffer;
  metadata?: unknown;
};

function toArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }

  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
}

export class MemoryKVNamespace {
  private readonly store = new Map<string, StoredValue>();

  async get(
    key: string,
    type?: 'text' | 'json' | 'arrayBuffer' | 'stream',
  ): Promise<string | ArrayBuffer | ReadableStream | unknown | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (type === 'arrayBuffer') {
      return entry.value instanceof ArrayBuffer
        ? entry.value.slice(0)
        : toArrayBuffer(new TextEncoder().encode(entry.value));
    }

    const text =
      typeof entry.value === 'string'
        ? entry.value
        : new TextDecoder().decode(new Uint8Array(entry.value));

    if (type === 'json') {
      return JSON.parse(text);
    }

    if (type === 'stream') {
      return new Blob([typeof entry.value === 'string' ? entry.value : entry.value]).stream();
    }

    return text;
  }

  async getWithMetadata<T>(
    key: string,
    type?: 'text' | 'json' | 'arrayBuffer' | 'stream',
  ): Promise<{
    value: string | ArrayBuffer | ReadableStream | unknown | null;
    metadata: T | null;
  }> {
    const entry = this.store.get(key);
    return {
      value: await this.get(key, type),
      metadata: (entry?.metadata as T | undefined) ?? null,
    };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: { metadata?: unknown; expirationTtl?: number },
  ): Promise<void> {
    const normalized = typeof value === 'string' ? value : toArrayBuffer(value);

    this.store.set(key, {
      value: normalized,
      metadata: options?.metadata === undefined ? undefined : structuredClone(options.metadata),
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
  }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor: string }> {
    const prefix = options?.prefix ?? '';
    const offset = options?.cursor ? Number(options.cursor) : 0;
    const keys = Array.from(this.store.keys())
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(offset)
      .map((name) => ({ name }));

    return {
      keys,
      list_complete: true,
      cursor: '',
    };
  }
}

type MemoryR2Entry = {
  body: ArrayBuffer;
  httpMetadata?: unknown;
  customMetadata?: Record<string, string>;
  etag: string;
  uploaded: Date;
};

function memoryR2Etag(): string {
  // Stable-ish etag: monotonically increasing counter is enough for tests
  // to detect "same object, different object, same bytes different identity".
  return `memr2-${++memoryR2EtagCounter}-${Math.random().toString(36).slice(2, 10)}`;
}
let memoryR2EtagCounter = 0;

async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.length > 0) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

class MemoryR2Bucket {
  private readonly store = new Map<string, MemoryR2Entry>();

  async head(
    key: string,
  ): Promise<{ key: string; size: number; etag: string; uploaded: Date } | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    return { key, size: entry.body.byteLength, etag: entry.etag, uploaded: entry.uploaded };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | Blob | string,
    options?: {
      httpMetadata?: unknown;
      customMetadata?: Record<string, string>;
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ): Promise<{ key: string; size: number; etag: string; uploaded: Date } | null> {
    // Evaluate precondition BEFORE draining the stream, matching R2's
    // behaviour on a wildcard etagDoesNotMatch='*' hit: if the key exists,
    // the put is a no-op and returns null. We still need to drain any
    // ReadableStream so a streaming producer (such as a hashing transform)
    // sees closure and settles its state.
    const preconditionFail = options?.onlyIf?.etagDoesNotMatch === '*' && this.store.has(key);

    let body: ArrayBuffer;
    if (typeof value === 'string') {
      body = toArrayBuffer(new TextEncoder().encode(value));
    } else if (value instanceof ReadableStream) {
      const bytes = await readStreamToBytes(value);
      body = toArrayBuffer(bytes);
    } else if (value instanceof Blob) {
      body = await value.arrayBuffer();
    } else {
      body = toArrayBuffer(value);
    }

    if (preconditionFail) {
      return null;
    }

    const entry: MemoryR2Entry = {
      body,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      etag: memoryR2Etag(),
      uploaded: new Date(),
    };
    this.store.set(key, entry);
    return { key, size: body.byteLength, etag: entry.etag, uploaded: entry.uploaded };
  }

  async get(key: string): Promise<{
    key: string;
    customMetadata?: Record<string, string>;
    size: number;
    etag: string;
    uploaded: Date;
    body: ReadableStream<Uint8Array>;
    arrayBuffer: () => Promise<ArrayBuffer>;
    text: () => Promise<string>;
    json: <T>() => Promise<T>;
  } | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    return {
      key,
      customMetadata: entry.customMetadata,
      size: entry.body.byteLength,
      etag: entry.etag,
      uploaded: entry.uploaded,
      body: new Response(entry.body).body!,
      arrayBuffer: async () => entry.body.slice(0),
      text: async () => new TextDecoder().decode(entry.body),
      json: async <T>() => JSON.parse(new TextDecoder().decode(entry.body)) as T,
    };
  }

  async list(options?: { prefix?: string }): Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
    truncated: boolean;
  }> {
    const prefix = options?.prefix ?? '';
    const objects = Array.from(this.store.entries())
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => ({
        key,
        size: entry.body.byteLength,
        uploaded: entry.uploaded,
      }));
    return { objects, truncated: false };
  }

  /**
   * Test-only helper: override the `uploaded` timestamp on an existing key.
   * Used by retention-sweep tests to simulate keys uploaded outside the
   * pending-upload protection window without sleeping for an hour.
   */
  setUploadedAt(key: string, uploaded: Date): void {
    const entry = this.store.get(key);
    if (entry) {
      entry.uploaded = uploaded;
    }
  }

  async delete(keys: string | Array<string>): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      this.store.delete(key);
    }
  }
}

let pglite: PGlite | undefined;
let pgPool: pg.Pool | undefined;
type QueryCapture = { active: boolean; queries: Array<string> };
const queryCaptures = new WeakMap<Db, QueryCapture>();

export async function captureQueries<T>(
  db: Db,
  run: () => Promise<T>,
): Promise<{ result: T; queries: Array<string> }> {
  const capture = queryCaptures.get(db);
  if (!capture || capture.active) {
    throw new Error('query capture is unavailable or already active');
  }
  capture.active = true;
  capture.queries = [];
  try {
    const result = await run();
    return { result, queries: [...capture.queries] };
  } finally {
    capture.active = false;
  }
}

/** Queries captured so far by the active `captureQueries` on `db`. */
export function capturedQueryCount(db: Db): number {
  const capture = queryCaptures.get(db);
  if (!capture?.active) {
    throw new Error('no query capture is active');
  }
  return capture.queries.length;
}

/**
 * Stateful CronScheduler namespace: `/sync` stores the posted state per
 * project, `/snapshot` returns it, `/clear` removes it. Records every call.
 */
export function createCronSchedulerMock(): {
  namespace: DurableObjectNamespace;
  states: Map<string, CronSyncState>;
  calls: Array<{ name: string; path: string }>;
} {
  const states = new Map<string, CronSyncState>();
  const calls: Array<{ name: string; path: string }> = [];
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString(): string }) => ({
      fetch: async (request: Request) => {
        const name = id.toString();
        const path = new URL(request.url).pathname;
        calls.push({ name, path });
        if (path === '/sync') {
          states.set(name, (await request.json()) as CronSyncState);
        } else if (path === '/clear') {
          states.delete(name);
        } else if (path === '/snapshot') {
          return Response.json({ state: states.get(name) ?? null });
        }
        return Response.json({ ok: true });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, states, calls };
}

export async function setupEnv(): Promise<TestEnv> {
  const kv = new MemoryKVNamespace();
  const isrCache = new MemoryKVNamespace();
  const staticAssets = new MemoryKVNamespace();
  const staticAssetsR2 = new MemoryR2Bucket();

  const databaseUrl = process.env.VOID_TEST_DATABASE_URL;
  const queryCapture: QueryCapture = { active: false, queries: [] };
  const logger = {
    logQuery(query: string) {
      if (queryCapture.active) {
        queryCapture.queries.push(query);
      }
    },
  };
  let db: TestEnv['db'];
  if (databaseUrl) {
    pgPool = new pg.Pool({ connectionString: databaseUrl });
    db = drizzlePg(pgPool, { schema, logger });
  } else {
    pglite = new PGlite({
      loadDataDir: await loadPGliteTemplateBundle(),
      relaxedDurability: true,
    });
    // PGlite uses the same queries but exposes its own driver result type.
    db = drizzle(pglite, { schema, logger }) as unknown as TestEnv['db'];
  }
  queryCaptures.set(db, queryCapture);

  // Register the test db so the vi.mock in setup.ts routes createDb() here
  setTestDb(db);

  return {
    db,
    HYPERDRIVE: { connectionString: 'test://mock' },
    ISR_CACHE: isrCache as unknown as KVNamespace,
    ROUTING: kv as unknown as KVNamespace,
    STATIC_ASSETS: staticAssets as unknown as KVNamespace,
    STATIC_ASSETS_R2: staticAssetsR2 as unknown as R2Bucket,
    DISPATCH: {} as DispatchNamespace,
    CF_API_TOKEN,
    CF_ACCOUNT_ID,
    CF_ZONE_ID,
    JWT_SECRET,
    EMAIL_SIGNING_SECRET,
    PLATFORM_AUTH_DATABASE_UNCACHED: 'true',
    PROJECT_SECRET_KEYS_JSON,
    PROJECT_SECRET_ACTIVE_KEY_VERSION,
    R2_ACCESS_KEY_ID: 'test-r2-access-key-id',
    R2_SECRET_ACCESS_KEY: 'test-r2-secret-access-key',
    R2_STATIC_ASSETS_BUCKET: 'void-static-assets-overflow-test',
    GITHUB_CLIENT_ID: 'test-github-client-id',
    GITHUB_CLIENT_SECRET: 'test-github-client-secret',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    REQUESTS_DATASET: 'void_requests',
    TAIL_SERVICE_NAME: 'void-tail',
    USAGE_COUNTER: createMockDoNamespace(),
    CRON_SCHEDULER: createMockDoNamespace(),
    ERROR_ALERT_MONITOR: createMockDoNamespace(),
    SANDBOX_CONCURRENCY_COUNTER:
      createMockDoNamespace() as unknown as DurableObjectNamespace<SandboxConcurrencyCounter>,
    BUILD_SCHEDULER: createMockDoNamespace(),
    BUILD_MANAGER: createMockDoNamespace(),
    BUILD_MANAGER_LARGE: createMockDoNamespace(),
  };
}

export async function teardownEnv(): Promise<void> {
  clearTestDb();
  if (pgPool) {
    await pgPool.end();
    pgPool = undefined;
  }
  if (pglite) {
    await pglite.close();
    pglite = undefined;
  }
}

export async function clearTables(db: Db): Promise<void> {
  const tables = [
    schema.previewTickets,
    schema.oauthRequests,
    schema.projectCleanupJobs,
    schema.emailDestinationCleanups,
    schema.emailOperationSteps,
    schema.emailOperations,
    schema.emailSharedRecipients,
    schema.emailDomainRoutes,
    schema.emailZoneConnections,
    schema.emailCredentials,
    schema.emailCacheOutbox,
    schema.emailUnresolvedAttempts,
    schema.emailActionRecipients,
    schema.emailActions,
    schema.emailReceipts,
    schema.emailProjectControls,
    schema.emailMonthlyUsage,
    sandboxDrainCheckpoints,
    domains,
    resources,
    projectSecrets,
    builds,
    githubConnections,
    githubInstallationMembers,
    githubInstallationRevocations,
    githubInstallations,
    githubWebhookRedeliveries,
    deployments,
    projects,
    schema.oauthGrants,
    schema.oauthClients,
    invitations,
    oauthAccounts,
    users,
    oauthNonces,
    authCodes,
    operatorSessions,
    operatorEvents,
    schema.platformAuthAttempts,
    schema.platformAuthBootstrap,
    schema.platformLoginTests,
    schema.platformLoginRevisions,
    schema.platformLoginConnections,
    schema.platformAuthSettings,
    platformSettings,
  ];
  await db.execute(sql`do $$ begin
    ${sql.join(
      tables.map((table) => sql`delete from ${table};`),
      sql`\n`,
    )}
  end $$;`);
}

/** Keep both orphan sweeps while skipping the provider-settling wait in in-memory tests. */
export function skipOrphanSweepDelay(): void {
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    schedule(callback, delay === 2000 ? 0 : delay, ...args),
  );
}

/** Establish a real revocable operator session for integration requests. */
export async function createOperatorToken(
  db: Db,
  user: { id: string; login: string },
  origin = 'http://localhost',
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .insert(operatorSessions)
    .values({ id, user_id: user.id, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  return signJwt(
    { sub: user.id, login: user.login, aud: 'operator', jti: id, operatorOrigin: origin },
    JWT_SECRET,
    { ttlSeconds: 3600 },
  );
}

export async function seedOAuthNonce(db: Db, nonce: string): Promise<void> {
  await db.insert(oauthNonces).values({ nonce, expires_at: sql`now() + interval '600 seconds'` });
}

/** All cached members of an installation, newest verification first. */
export async function getTestGitHubInstallationMembers(
  db: Db,
  installationId: string,
): Promise<ReadonlyArray<GitHubInstallationMember>> {
  return db
    .select()
    .from(githubInstallationMembers)
    .where(eq(githubInstallationMembers.installation_id, installationId))
    .orderBy(desc(githubInstallationMembers.verified_at));
}

let userCounter = 0;

export async function createTestUser(
  db: Db,
  login = 'testuser',
  provider = 'github',
  providerId?: string,
  plan: PlanId = 'free',
  role: 'user' | 'admin' = 'user',
): Promise<{ id: string; login: string; jwt: string; adminJwt: string }> {
  const id = `user_test${++userCounter}`;
  const pid = providerId ?? String(10000 + userCounter);
  await db.insert(users).values({
    id,
    provider,
    provider_id: pid,
    login,
    email: null,
    plan,
    role,
  });
  await db.insert(oauthAccounts).values({
    id: generateId('oa'),
    user_id: id,
    provider,
    provider_id: pid,
  });
  const jwt = await signJwt({ sub: id, login, aud: 'api' }, JWT_SECRET);
  const adminJwt = await signJwt({ sub: id, login, aud: 'admin' }, JWT_SECRET);
  return { id, login, jwt, adminJwt };
}

let projectCounter = 0;

export async function createTestProject(
  db: Db,
  userId: string,
  slug?: string,
): Promise<{ id: string; slug: string }> {
  const n = ++projectCounter;
  const s = slug ?? `test-project-${n}`;
  // Same shape as generateId('proj'): internal routes reject any other id.
  const id = `proj_test${String(n).padStart(8, '0')}`;
  await db.insert(projects).values({ id, user_id: userId, slug: s });
  return { id, slug: s };
}

export async function createTestBuild(
  db: Db,
  args: {
    projectId: string;
    userId: string;
    executor?: Build['executor'];
    commitSha?: string | null;
    branch?: string | null;
    githubRunId?: string | null;
    githubRunAttempt?: string | null;
    logsUrl?: string | null;
    instanceType?: string | null;
    status?: Build['status'];
  },
): Promise<Build> {
  const id = generateId('bld');
  const [row] = await db
    .insert(builds)
    .values({
      id,
      project_id: args.projectId,
      user_id: args.userId,
      executor: args.executor ?? 'container',
      status: args.status ?? 'queued',
      commit_sha: args.commitSha ?? null,
      branch: args.branch ?? null,
      github_run_id: args.githubRunId ?? null,
      github_run_attempt: args.githubRunAttempt ?? null,
      logs_url: args.logsUrl ?? null,
      instance_type: args.instanceType ?? null,
    })
    .returning();
  return row;
}

let deploymentCounter = 0;

export async function createTestDeployment(
  db: Db,
  projectId: string,
  status:
    | 'pending'
    | 'uploading'
    | 'migrating'
    | 'prerendering'
    | 'canceling'
    | 'live'
    | 'failed'
    | 'canceled' = 'live',
  source?: string,
  errorMessage?: string,
  options?: {
    cliVersion?: string | null;
    commit?: string | null;
    admissionProtocol?: number;
  },
): Promise<{ id: string }> {
  const n = ++deploymentCounter;
  const id = `dpl_test${n}`;
  // Mirror production semantics from `updateDeploymentStatus`:
  // `deployed_at` is stamped via `COALESCE(deployed_at, now())` on the
  // first transition to `live` and is never overwritten. Tests seeding
  // a deployment directly in `live` state need the same marker, otherwise
  // `getActivatedDeployments` won't see it.
  await db.insert(deployments).values({
    id,
    project_id: projectId,
    status,
    source: source ?? null,
    cli_version: options?.cliVersion ?? null,
    // The commit this deployment published, when the caller wants to exercise
    // the `deployments.commit == pushed SHA` freshness fallback (the supersede
    // rollback gate). Left null otherwise (container deploys record no commit).
    commit: options?.commit ?? null,
    error_message: errorMessage ?? null,
    admission_protocol: options?.admissionProtocol,
    // Production deploys always have a manifest set after `updateDeploymentManifest`
    // (post-parse). Test fixtures seeding rows directly need a non-null
    // manifest so they're counted by `countUserDeploymentsToday` (which
    // filters `manifest IS NOT NULL` to exclude precheck placeholders).
    manifest: '{}',
    deployed_at: status === 'live' ? sql`now()` : null,
  });
  if (status === 'live') {
    await db.update(projects).set({ active_deployment_id: id }).where(eq(projects.id, projectId));
  }
  return { id };
}

export async function createTestProjectSecret(
  db: Db,
  env: Pick<TestEnv, 'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'>,
  projectId: string,
  name: string,
  value: string,
  managedReason: string | null = null,
): Promise<void> {
  const encrypted = await encryptProjectSecret(env, projectId, name, value);
  await db
    .insert(projectSecrets)
    .values({
      id: generateId('psc'),
      project_id: projectId,
      name,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      key_version: encrypted.keyVersion,
      managed_reason: managedReason,
    })
    .onConflictDoUpdate({
      target: [projectSecrets.project_id, projectSecrets.name],
      set: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        key_version: encrypted.keyVersion,
        managed_reason: managedReason,
        updated_at: sql`now()`,
      },
    });
}

// --- Fetch mocking ---

export function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

export function cfError(message: string, status = 400, code = 1000): Response {
  return Response.json({ success: false, errors: [{ code, message }] }, { status });
}

// ---------------------------------------------------------------------------
// Dispatch script / container application stateful mock infrastructure
// ---------------------------------------------------------------------------
//
// Sandbox-related integration tests need a mock fetch that can model:
//   - WfP dispatch namespace scripts that mint a stable namespace_id on first
//     PUT (when `metadata.migrations` declares `new_sqlite_classes`) and
//     PRESERVE that namespace_id on subsequent PUTs without migrations (the
//     wrangler migration_tag protocol).
//   - Container applications keyed by name with POST/PATCH/DELETE/GET. The
//     container POST also enforces the CF invariant that a given DO
//     namespace_id can only ever be bound to ONE container application
//     (CF code 1608 DURABLE_OBJECT_ALREADY_HAS_APPLICATION).
//   - Cross-script DO binding validation — CF rejects cross-script DO bindings
//     to dispatch namespace scripts; only same-script DO bindings work in
//     dispatch namespaces.
//   - Recording of CF call ordering so tests can assert PUT/POST sequencing.
//
// The state container is fresh per `mockCfApi()` call.
// ---------------------------------------------------------------------------

export type SandboxMockHostScript = {
  /** wrangler-style migration_tag — present once `migrations` has been applied. */
  migration_tag?: string;
  /** className -> namespace_id (stable per-script-per-class). */
  classes: Map<string, string>;
  /** Most recent bindings list parsed from the multipart PUT body. */
  bindings: Array<{
    type: string;
    name?: string;
    class_name?: string;
    namespace_id?: string;
    script_name?: string;
    [key: string]: unknown;
  }>;
  /** Raw last-PUT metadata object. */
  metadata: Record<string, unknown>;
};

export type SandboxMockContainerApp = {
  id: string;
  name: string;
  scheduling_policy?: string;
  configuration: { image?: string; instance_type?: string };
  max_instances: number;
  durable_objects: { namespace_id: string };
};

export type SandboxMockState = {
  /** scriptName -> recorded dispatch namespace script state. */
  hostScripts: Map<string, SandboxMockHostScript>;
  /** appId -> recorded container application state. */
  containerApps: Map<string, SandboxMockContainerApp>;
  /** Structured ordered recording of every method-modifying call. */
  recordedCalls: Array<{ method: string; url: string; body?: string | undefined }>;
};

function createSandboxMockState(): SandboxMockState {
  return {
    hostScripts: new Map(),
    containerApps: new Map(),
    recordedCalls: [],
  };
}

/**
 * Worker uploads stream their multipart body. Parse the bytes the platform
 * actually sends and put the resulting FormData on `init.body`, so handlers
 * and later `mock.calls` assertions read the parts as they would read a
 * FormData body. A body stream that errors (a module failing its integrity
 * check) rejects here, as `fetch` would; the upload never reaches a handler.
 */
async function readStreamedMultipartBody(init: RequestInit): Promise<void> {
  const contentType = new Headers(init.headers).get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    return;
  }
  const form = await new Response(init.body, {
    headers: { 'content-type': contentType },
  }).formData();
  init.body = form;
}

/**
 * Best-effort multipart-body parser tailored to the platform's CF Workers
 * Upload API usage. Returns the parsed `metadata` JSON and the raw bindings
 * array if present. Returns `null` if the body is not a parseable multipart
 * form (e.g. tests overriding `uploadWorker` may supply opaque bodies).
 */
async function parseMultipartMetadata(
  init: RequestInit | undefined,
): Promise<{ metadata: Record<string, unknown> } | null> {
  if (!init?.body) {
    return null;
  }
  // Worker uploads send FormData.
  if (init.body instanceof FormData) {
    const metaEntry = init.body.get('metadata');
    if (typeof metaEntry === 'string') {
      try {
        return { metadata: JSON.parse(metaEntry) };
      } catch {
        return null;
      }
    }
    if (metaEntry instanceof Blob) {
      try {
        return { metadata: JSON.parse(await metaEntry.text()) };
      } catch {
        return null;
      }
    }
  }
  // Some helpers serialize their own multipart string. We don't attempt to
  // parse arbitrary multipart strings — tests that pass strings either don't
  // need binding validation or they install a custom uploadWorker handler.
  return null;
}

function mintNamespaceId(scriptName: string, className: string): string {
  // Deterministic and unique per (scriptName, className). Test code only
  // cares about stability across calls, not the exact format.
  return `ns_${scriptName}_${className}`;
}

function extractBindings(metadata: Record<string, unknown>): Array<{
  type: string;
  name?: string;
  class_name?: string;
  script_name?: string;
  [key: string]: unknown;
}> {
  const raw = (metadata as { bindings?: unknown }).bindings;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (b): b is Record<string, unknown> => typeof b === 'object' && b !== null,
  ) as Array<{
    type: string;
    name?: string;
    class_name?: string;
    script_name?: string;
    [key: string]: unknown;
  }>;
}

function pushStringValues(into: Array<string>, src: unknown): void {
  if (!Array.isArray(src)) {
    return;
  }
  for (const c of src) {
    if (typeof c === 'string') {
      into.push(c);
    }
  }
}

function extractNewSqliteClasses(metadata: Record<string, unknown>): Array<string> {
  const migrations = metadata.migrations;
  if (!migrations) {
    return [];
  }
  const classes: Array<string> = [];
  // CF Workers Upload API shape: `{ new_tag, steps: [{ new_sqlite_classes, new_classes }] }`
  if (typeof migrations === 'object' && !Array.isArray(migrations)) {
    const obj = migrations as {
      steps?: unknown;
      new_sqlite_classes?: unknown;
      new_classes?: unknown;
    };
    pushStringValues(classes, obj.new_sqlite_classes);
    pushStringValues(classes, obj.new_classes);
    if (Array.isArray(obj.steps)) {
      for (const step of obj.steps) {
        if (typeof step === 'object' && step !== null) {
          const s = step as { new_sqlite_classes?: unknown; new_classes?: unknown };
          pushStringValues(classes, s.new_sqlite_classes);
          pushStringValues(classes, s.new_classes);
        }
      }
    }
  }
  // Wrangler config-array shape: `[{ tag, new_sqlite_classes }]`
  if (Array.isArray(migrations)) {
    for (const step of migrations) {
      if (typeof step === 'object' && step !== null) {
        const s = step as { new_sqlite_classes?: unknown; new_classes?: unknown };
        pushStringValues(classes, s.new_sqlite_classes);
        pushStringValues(classes, s.new_classes);
      }
    }
  }
  return classes;
}

function extractMigrationTag(metadata: Record<string, unknown>): string | undefined {
  const migrations = metadata.migrations;
  if (!migrations) {
    return undefined;
  }
  if (typeof migrations === 'object' && !Array.isArray(migrations)) {
    const obj = migrations as { new_tag?: unknown; tag?: unknown };
    if (typeof obj.new_tag === 'string') {
      return obj.new_tag;
    }
    if (typeof obj.tag === 'string') {
      return obj.tag;
    }
  }
  if (Array.isArray(migrations)) {
    // Wrangler config form — last `tag` wins.
    let tag: string | undefined;
    for (const step of migrations) {
      if (typeof step === 'object' && step !== null) {
        const s = step as { tag?: unknown };
        if (typeof s.tag === 'string') {
          tag = s.tag;
        }
      }
    }
    return tag;
  }
  return undefined;
}

function parseScriptNameFromUrl(url: string): string | null {
  // .../workers/dispatch/namespaces/{ns}/scripts/{name}[/...]
  const m = /\/workers\/(?:dispatch\/namespaces\/[^/]+\/)?scripts\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

function parseAppIdFromUrl(url: string): string | null {
  // .../containers/applications/{id}[/...]
  const m = /\/containers\/applications\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

function parseAppNameQuery(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get('name');
  } catch {
    return null;
  }
}

export type CfApiMocks = {
  createD1: (url: string, init?: RequestInit) => Response;
  createKV: (url: string, init?: RequestInit) => Response;
  createR2: (url: string, init?: RequestInit) => Response;
  createHyperdrive: (url: string, init?: RequestInit) => Response;
  updateHyperdrive: (url: string, init?: RequestInit) => Response;
  listHyperdrive: (url: string, init?: RequestInit) => Response;
  createQueue: (url: string, init?: RequestInit) => Response;
  addQueueConsumer: (url: string, init?: RequestInit) => Response;
  listQueueConsumers: (url: string, init?: RequestInit) => Response;
  updateQueueConsumer: (url: string, init?: RequestInit) => Response;
  listWorkerBindings: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteD1: (url: string, init?: RequestInit) => Response;
  deleteKV: (url: string, init?: RequestInit) => Response;
  deleteR2: (url: string, init?: RequestInit) => Response;
  deleteHyperdrive: (url: string, init?: RequestInit) => Response;
  deleteQueue: (url: string, init?: RequestInit) => Response;
  deleteWorker: (url: string, init?: RequestInit) => Response | Promise<Response>;
  queryD1: (url: string, init?: RequestInit) => Response | Promise<Response>;
  uploadWorker: (url: string, init?: RequestInit) => Response | Promise<Response>;
  assetUploadSession: (url: string, init?: RequestInit) => Response | Promise<Response>;
  assetUpload: (url: string, init?: RequestInit) => Response | Promise<Response>;
  listWorkerSecrets: (url: string, init?: RequestInit) => Response | Promise<Response>;
  setWorkerSecret: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteWorkerSecret: (url: string, init?: RequestInit) => Response | Promise<Response>;
  createCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  listCustomHostnames: (url: string, init?: RequestInit) => Response | Promise<Response>;
  getCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  patchCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteCustomHostname: (url: string, init?: RequestInit) => Response | Promise<Response>;
  purgeCache: (url: string, init?: RequestInit) => Response | Promise<Response>;
  analyticsQuery: (url: string, init?: RequestInit) => Response | Promise<Response>;
  // CF Email Routing account-level destination-address API. Backs
  // `provisioning/email-routing.ts` (add / list / delete).
  addEmailDestination: (url: string, init?: RequestInit) => Response | Promise<Response>;
  listEmailDestinations: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteEmailDestination: (url: string, init?: RequestInit) => Response | Promise<Response>;
  // Dispatch script / container-app endpoints. State-aware defaults are wired
  // up when overrides are not supplied. Tests can still override individually.
  getDispatchScript?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  patchScriptSettings?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  prepareContainerImage?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  createContainerApp?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  patchContainerApp?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  deleteContainerApp?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  getContainerApp?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  listContainerApps?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  postContainerAppRollout?: (url: string, init?: RequestInit) => Response | Promise<Response>;
};

const baseDefaultMocks: Omit<CfApiMocks, 'uploadWorker' | 'listWorkerBindings' | 'deleteWorker'> = {
  createD1: () => cfSuccess({ uuid: 'd1-test-uuid', name: 'test-db' }),
  createKV: () => cfSuccess({ id: 'kv-test-id', title: 'test-kv' }),
  createR2: () => cfSuccess({ name: 'test-bucket' }),
  createHyperdrive: () => cfSuccess({ id: 'hd-test-id', name: 'test-hyperdrive' }),
  updateHyperdrive: () => cfSuccess({ id: 'hd-test-id', name: 'test-hyperdrive' }),
  listHyperdrive: () => cfSuccess([]),
  createQueue: () =>
    cfSuccess({ queue_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', queue_name: 'test-queue' }),
  addQueueConsumer: () => cfSuccess({}),
  listQueueConsumers: () => cfSuccess([]),
  updateQueueConsumer: () => cfSuccess({}),
  deleteD1: () => cfSuccess(null),
  deleteKV: () => cfSuccess(null),
  deleteR2: () => cfSuccess(null),
  deleteHyperdrive: () => cfSuccess(null),
  deleteQueue: () => cfSuccess(null),
  queryD1: () => cfSuccess([{ results: [] }]),
  assetUploadSession: async (_url: string, init?: RequestInit) => {
    // Echo the manifest hashes so the mock bucket matches what the deploy
    // route computed.
    try {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (body?.manifest) {
        const hashes = [
          ...new Set(
            Object.values(body.manifest as Record<string, unknown>).flatMap((entry) => {
              if (typeof entry === 'object' && entry !== null && 'hash' in entry) {
                const hash = (entry as { hash?: unknown }).hash;
                return typeof hash === 'string' ? [hash] : [];
              }
              return [];
            }),
          ),
        ];
        return cfSuccess({ jwt: 'test-asset-jwt', buckets: [hashes] });
      }
    } catch {
      // fall through to default
    }
    return cfSuccess({ jwt: 'test-asset-jwt', buckets: [['hash1']] });
  },
  assetUpload: () => cfSuccess({ jwt: 'test-completion-jwt' }),
  listWorkerSecrets: () => cfSuccess([]),
  setWorkerSecret: () => cfSuccess({}),
  deleteWorkerSecret: () => cfSuccess({}),
  createCustomHostname: () =>
    cfSuccess({
      id: 'ch-test-id',
      hostname: 'test.example.com',
      status: 'pending',
      ssl: {
        status: 'pending_validation',
        method: 'http',
        type: 'dv',
      },
      ownership_verification: {
        type: 'txt',
        name: '_cf-custom-hostname.test.example.com',
        value: 'test-ownership-token',
      },
    }),
  listCustomHostnames: () => cfSuccess([]),
  getCustomHostname: () =>
    cfSuccess({
      id: 'ch-test-id',
      hostname: 'test.example.com',
      status: 'pending',
      ssl: {
        status: 'pending_validation',
        method: 'http',
        type: 'dv',
      },
      ownership_verification: {
        type: 'txt',
        name: '_cf-custom-hostname.test.example.com',
        value: 'test-ownership-token',
      },
    }),
  patchCustomHostname: () =>
    cfSuccess({
      id: 'ch-test-id',
      hostname: 'test.example.com',
      status: 'pending',
      ssl: {
        status: 'pending_validation',
        method: 'http',
        type: 'dv',
      },
      ownership_verification: {
        type: 'txt',
        name: '_cf-custom-hostname.test.example.com',
        value: 'test-ownership-token',
      },
    }),
  deleteCustomHostname: () => cfSuccess(null),
  purgeCache: () => cfSuccess({ id: 'purge-test-id' }),
  analyticsQuery: () => Response.json({ data: [{ requests: 0, bandwidth_bytes: 0 }] }),
  // Fresh add: CF echoes the row back immediately with `verified: null` —
  // the recipient has been mailed a link but hasn't clicked it yet. The tag
  // is derived from the address so a test can predict it without capturing
  // the response.
  addEmailDestination: (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const email = typeof body.email === 'string' ? body.email : 'test@example.com';
    return cfSuccess({
      tag: `cf-tag-${email}`,
      email,
      verified: null,
      created: '2026-04-27T00:00:00Z',
      modified: '2026-04-27T00:00:00Z',
    });
  },
  // `listDestinations` paginates until a short page comes back, so an empty
  // array terminates after one request.
  listEmailDestinations: () => cfSuccess([]),
  deleteEmailDestination: (url: string) => {
    const tag = url.split('/').pop()?.split('?')[0] ?? 'unknown';
    return cfSuccess({ tag });
  },
};

/**
 * Mock fetch handle. The handle IS the `vi.fn()` (e.g. `fetchMock.mock.calls`),
 * with `state` / `seedHostScript` / `seedContainerApp` / `expectCallOrder`
 * attached for sandbox scenarios (dispatch namespace scripts + container apps).
 */
export type MockCfApiHandle = ReturnType<typeof vi.fn> & {
  /** Live state container — fresh per `mockCfApi()` call. */
  state: SandboxMockState;
  /**
   * Seed a dispatch namespace script directly into the mock state without
   * going through a real PUT. Useful for fixturing tests that assert the
   * cached-fast-path of a deploy or set up cross-script binding precondition.
   */
  seedHostScript(args: {
    scriptName: string;
    migrationTag?: string;
    classes?: Record<string, string>;
    bindings?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
  }): SandboxMockHostScript;
  /**
   * Seed a container application directly into the mock state. The minted id
   * is `app_<name>` to match the create handler's id format.
   */
  seedContainerApp(args: {
    name: string;
    namespaceId: string;
    image?: string;
    instanceType?: string;
    maxInstances?: number;
  }): SandboxMockContainerApp;
  /**
   * Assert that a sequence of substrings appears (in order) in the recorded
   * call URLs. Each substring may be a plain URL fragment or an object with
   * `{ method, url }` for a stricter match.
   */
  expectCallOrder(...steps: Array<string | { method: string; url: string }>): void;
};

export function mockCfApi(overrides: Partial<CfApiMocks> = {}): MockCfApiHandle {
  const state = createSandboxMockState();

  // ------------------------------------------------------------------------
  // State-aware defaults (closure over `state`).
  // ------------------------------------------------------------------------

  // Default `uploadWorker` parses the multipart metadata, mints + preserves
  // namespace_ids, validates cross-script bindings, and records the script.
  const defaultUploadWorker = async (url: string, init?: RequestInit): Promise<Response> => {
    const scriptName = parseScriptNameFromUrl(url);
    if (!scriptName) {
      return new Response('ok', { status: 200 });
    }

    const parsed = await parseMultipartMetadata(init);
    if (!parsed) {
      // Opaque body (string or non-FormData): accept without recording state.
      // Tests that need state for these bodies install their own override.
      return new Response('ok', { status: 200 });
    }

    const { metadata } = parsed;
    const bindings = extractBindings(metadata);

    // Cross-script binding validation. CF empirically rejects ALL cross-script DO bindings between dispatch
    // namespace scripts, regardless of whether the target script exists or
    // declares the class as container-enabled. Reject unconditionally so any
    // future code that introduces cross-script DO bindings fails fast in CI
    // instead of shipping to production.
    for (const binding of bindings) {
      const refScript = (binding as { script_name?: unknown }).script_name;
      if (typeof refScript === 'string' && refScript !== scriptName) {
        return Response.json(
          {
            success: false,
            errors: [
              {
                code: 10061,
                message: `Cannot create binding for class in script '${refScript}' that does not exist.`,
              },
            ],
          },
          { status: 400 },
        );
      }
    }

    // Resolve / mint namespace_ids for declared classes.
    const existing = state.hostScripts.get(scriptName);
    const declaredClasses = extractNewSqliteClasses(metadata);
    const newTag = extractMigrationTag(metadata);

    const classes: Map<string, string> = new Map(existing?.classes);
    for (const className of declaredClasses) {
      if (!classes.has(className)) {
        classes.set(className, mintNamespaceId(scriptName, className));
      }
    }

    // Tag handling: declaring `migrations` advances the tag (or creates one);
    // omitting `migrations` preserves whatever tag was already there.
    const migrationTag = newTag ?? existing?.migration_tag;

    // Populate same-script DO bindings with their resolved namespace_id so
    // GET /bindings reflects what `findDurableObjectNamespaceId` reads.
    const persistedBindings = bindings.map((b) => {
      if (
        b.type === 'durable_object_namespace' &&
        typeof b.class_name === 'string' &&
        !b.script_name
      ) {
        const nsId = classes.get(b.class_name);
        if (nsId) {
          return { ...b, namespace_id: nsId };
        }
      }
      return b;
    });

    state.hostScripts.set(scriptName, {
      migration_tag: migrationTag,
      classes,
      bindings: persistedBindings,
      metadata,
    });

    return new Response('ok', { status: 200 });
  };

  // Default `listWorkerBindings` reads from state when the script has been
  // PUT through the stateful path; otherwise returns a proxy-token binding.
  const defaultListWorkerBindings = (url: string): Response => {
    const scriptName = parseScriptNameFromUrl(url);
    if (scriptName && state.hostScripts.has(scriptName)) {
      const script = state.hostScripts.get(scriptName)!;
      return cfSuccess(script.bindings);
    }
    return cfSuccess([
      { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'mock-proxy-token' },
    ]);
  };

  // Default `deleteWorker` removes the script from state. Unknown scripts
  // also return 200 (idempotent delete); tests that need a 404 install an
  // override.
  const defaultDeleteWorker = (url: string): Response => {
    const scriptName = parseScriptNameFromUrl(url);
    if (scriptName) {
      state.hostScripts.delete(scriptName);
    }
    return new Response('ok', { status: 200 });
  };

  // GET dispatch script — returns metadata including migration_tag.
  //
  // Matches the real CF API envelope:
  //   { success: true, result: { script: { id, migration_tag, ... } } }
  //
  // (See workers-sdk/packages/wrangler/src/durable.ts — wrangler reads
  // `result.script.migration_tag`, not `result.migration_tag`.)
  const defaultGetDispatchScript = (url: string): Response => {
    const scriptName = parseScriptNameFromUrl(url);
    if (!scriptName || !state.hostScripts.has(scriptName)) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }],
        },
        { status: 404 },
      );
    }
    const script = state.hostScripts.get(scriptName)!;
    return cfSuccess({
      script: {
        id: scriptName,
        migration_tag: script.migration_tag ?? null,
        ...script.metadata,
      },
    });
  };

  // PATCH dispatch script settings — the binding list replaces the stored one:
  // `inherit` keeps the stored binding of that name (unknown name → 400) and a
  // name left out is removed. Echoes the new bindings like Cloudflare does.
  const defaultPatchScriptSettings = async (url: string, init?: RequestInit): Promise<Response> => {
    const scriptName = parseScriptNameFromUrl(url);
    const script = scriptName ? state.hostScripts.get(scriptName) : undefined;
    if (!script) {
      return cfError('workers.api.error.script_not_found', 404, 10007);
    }
    const part = init?.body instanceof FormData ? init.body.get('settings') : null;
    const settings = (
      part instanceof Blob
        ? JSON.parse(await part.text())
        : typeof part === 'string'
          ? JSON.parse(part)
          : null
    ) as { bindings?: Array<{ type: string; name: string; [key: string]: unknown }> } | null;
    if (!Array.isArray(settings?.bindings)) {
      return cfError('settings.bindings is required', 400);
    }
    const bindings: SandboxMockHostScript['bindings'] = [];
    for (const binding of settings.bindings) {
      if (binding.type !== 'inherit') {
        bindings.push(binding);
        continue;
      }
      const stored = script.bindings.find((entry) => entry.name === binding.name);
      if (!stored) {
        return cfError(`cannot inherit unknown binding ${binding.name}`, 400);
      }
      bindings.push(stored);
    }
    script.bindings = bindings;
    return cfSuccess({ bindings });
  };

  // Container app handlers.
  const defaultListContainerApps = (url: string): Response => {
    const name = parseAppNameQuery(url);
    if (!name) {
      return cfSuccess(Array.from(state.containerApps.values()));
    }
    const app = Array.from(state.containerApps.values()).find((a) => a.name === name);
    return cfSuccess(app ? [app] : []);
  };

  const defaultGetContainerApp = (url: string): Response => {
    const id = parseAppIdFromUrl(url);
    if (!id || !state.containerApps.has(id)) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 1000, message: 'container application not found' }],
        },
        { status: 404 },
      );
    }
    return cfSuccess(state.containerApps.get(id));
  };

  const defaultCreateContainerApp = async (_url: string, init?: RequestInit): Promise<Response> => {
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) {
      return Response.json(
        { success: false, errors: [{ code: 1000, message: 'name is required' }] },
        { status: 400 },
      );
    }
    const conflict = Array.from(state.containerApps.values()).find((a) => a.name === name);
    if (conflict) {
      return Response.json(
        { success: false, errors: [{ code: 1000, message: 'already exists' }] },
        { status: 409 },
      );
    }
    // CF rejects a 2nd container application bound to the same DO
    // namespace_id with code 1608 DURABLE_OBJECT_ALREADY_HAS_APPLICATION
    // (verified against the real CF API). Each deploy mints a fresh
    // namespace_id, so healthy code never hits this.
    const namespaceId = (body.durable_objects as { namespace_id?: string } | undefined)
      ?.namespace_id;
    if (namespaceId) {
      const namespaceConflict = Array.from(state.containerApps.values()).find(
        (a) => a.durable_objects.namespace_id === namespaceId,
      );
      if (namespaceConflict) {
        return Response.json(
          {
            success: false,
            errors: [
              {
                code: 1608,
                message: `DURABLE_OBJECT_ALREADY_HAS_APPLICATION: namespace_id ${namespaceId} is already bound to application ${namespaceConflict.name}`,
              },
            ],
          },
          { status: 400 },
        );
      }
    }
    const durableObjects = (body.durable_objects as { namespace_id?: string } | undefined) ?? {
      namespace_id: '',
    };
    const configuration =
      (body.configuration as { image?: string; instance_type?: string } | undefined) ?? {};
    const app: SandboxMockContainerApp = {
      id: `app_${name}`,
      name,
      scheduling_policy:
        typeof body.scheduling_policy === 'string' ? body.scheduling_policy : 'default',
      configuration: {
        image: configuration.image,
        instance_type: configuration.instance_type ?? 'lite',
      },
      max_instances: typeof body.max_instances === 'number' ? body.max_instances : 20,
      durable_objects: { namespace_id: durableObjects.namespace_id ?? '' },
    };
    state.containerApps.set(app.id, app);
    return cfSuccess(app);
  };

  const defaultPatchContainerApp = async (url: string, init?: RequestInit): Promise<Response> => {
    const id = parseAppIdFromUrl(url);
    if (!id || !state.containerApps.has(id)) {
      return Response.json(
        { success: false, errors: [{ code: 1000, message: 'not found' }] },
        { status: 404 },
      );
    }
    const app = state.containerApps.get(id)!;
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
    if (body.configuration && typeof body.configuration === 'object') {
      const cfg = body.configuration as { image?: string; instance_type?: string };
      app.configuration = {
        image: cfg.image ?? app.configuration.image,
        instance_type: cfg.instance_type ?? app.configuration.instance_type,
      };
    }
    if (typeof body.max_instances === 'number') {
      app.max_instances = body.max_instances;
    }
    state.containerApps.set(id, app);
    return cfSuccess(app);
  };

  const defaultDeleteContainerApp = (url: string): Response => {
    const id = parseAppIdFromUrl(url);
    if (!id || !state.containerApps.has(id)) {
      return Response.json(
        { success: false, errors: [{ code: 1000, message: 'not found' }] },
        { status: 404 },
      );
    }
    state.containerApps.delete(id);
    return cfSuccess(null);
  };

  const defaultPostContainerAppRollout = (): Response => {
    return cfSuccess({ id: 'rollout-test-id' });
  };

  const mocks: CfApiMocks = {
    ...baseDefaultMocks,
    uploadWorker: defaultUploadWorker,
    listWorkerBindings: defaultListWorkerBindings,
    deleteWorker: defaultDeleteWorker,
    getDispatchScript: defaultGetDispatchScript,
    patchScriptSettings: defaultPatchScriptSettings,
    createContainerApp: defaultCreateContainerApp,
    patchContainerApp: defaultPatchContainerApp,
    deleteContainerApp: defaultDeleteContainerApp,
    getContainerApp: defaultGetContainerApp,
    listContainerApps: defaultListContainerApps,
    postContainerAppRollout: defaultPostContainerAppRollout,
    ...overrides,
  };

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    if (init?.body instanceof ReadableStream) {
      await readStreamedMultipartBody(init);
    }

    // Record every call for ordering assertions. Non-string bodies are
    // summarized as `[FormData]` or `[binary]`.
    let bodySnapshot: string | undefined;
    if (init?.body !== undefined) {
      if (typeof init.body === 'string') {
        bodySnapshot = init.body;
      } else if (init.body instanceof FormData) {
        bodySnapshot = '[FormData]';
      } else {
        bodySnapshot = '[binary]';
      }
    }
    state.recordedCalls.push({ method, url, body: bodySnapshot });

    // Order matters: more specific patterns first.
    if (method === 'POST' && url.includes('/purge_cache')) {
      return mocks.purgeCache(url, init);
    }
    // CF Email Routing destinations. All three verbs share the
    // `/email/routing/addresses` prefix — DELETE and GET both land on
    // `/addresses/<tag>` or `/addresses?page=...`, POST on the bare
    // collection — so the method is the only disambiguator.
    if (url.includes('/email/routing/addresses')) {
      if (method === 'DELETE') {
        return mocks.deleteEmailDestination(url, init);
      }
      if (method === 'GET') {
        return mocks.listEmailDestinations(url, init);
      }
      if (method === 'POST') {
        return mocks.addEmailDestination(url, init);
      }
    }
    if (method === 'POST' && url.includes('/custom_hostnames')) {
      return mocks.createCustomHostname(url, init);
    }
    if (method === 'GET' && url.includes('/custom_hostnames?')) {
      return mocks.listCustomHostnames(url, init);
    }
    if (method === 'GET' && url.includes('/custom_hostnames/')) {
      return mocks.getCustomHostname(url, init);
    }
    if (method === 'PATCH' && url.includes('/custom_hostnames/')) {
      return mocks.patchCustomHostname(url, init);
    }
    if (method === 'DELETE' && url.includes('/custom_hostnames/')) {
      return mocks.deleteCustomHostname(url, init);
    }
    if (method === 'POST' && url.includes('/analytics_engine/sql')) {
      return mocks.analyticsQuery(url, init);
    }
    if (method === 'POST' && url.includes('/assets-upload-session')) {
      return mocks.assetUploadSession(url, init);
    }
    if (method === 'POST' && url.includes('/workers/assets/upload')) {
      return mocks.assetUpload(url, init);
    }
    if (method === 'GET' && url.includes('/hyperdrive/configs')) {
      return mocks.listHyperdrive(url, init);
    }
    if (method === 'POST' && url.includes('/hyperdrive/configs')) {
      return mocks.createHyperdrive(url, init);
    }
    if (method === 'PUT' && url.includes('/hyperdrive/configs/')) {
      return mocks.updateHyperdrive(url, init);
    }
    if (method === 'DELETE' && url.includes('/hyperdrive/configs/')) {
      return mocks.deleteHyperdrive(url, init);
    }

    if (method === 'POST' && url.endsWith('/containers/image-preparations')) {
      return (
        mocks.prepareContainerImage?.(url, init) ??
        cfSuccess({
          image: JSON.parse(String(init?.body)).image,
          status: 'ready',
        })
      );
    }

    // Container application endpoints (must come before the generic dispatch
    // worker matchers because both live under /accounts/{a}/...).
    if (
      method === 'POST' &&
      url.includes('/containers/applications/') &&
      url.endsWith('/rollouts')
    ) {
      return mocks.postContainerAppRollout!(url, init);
    }
    if (method === 'PATCH' && url.includes('/containers/applications/')) {
      return mocks.patchContainerApp!(url, init);
    }
    if (method === 'DELETE' && url.includes('/containers/applications/')) {
      return mocks.deleteContainerApp!(url, init);
    }
    if (method === 'GET' && url.includes('/containers/applications/')) {
      return mocks.getContainerApp!(url, init);
    }
    if (method === 'GET' && url.includes('/containers/applications')) {
      return mocks.listContainerApps!(url, init);
    }
    if (method === 'POST' && url.includes('/containers/applications')) {
      return mocks.createContainerApp!(url, init);
    }

    if (method === 'GET' && url.includes('/workers/dispatch/') && url.includes('/secrets')) {
      return mocks.listWorkerSecrets(url, init);
    }
    if (url.includes('/workers/scripts/')) {
      if (method === 'GET' && url.endsWith('/settings')) {
        const name = parseScriptNameFromUrl(url);
        const script = name ? state.hostScripts.get(name) : undefined;
        // Cloudflare accepts `props` on a service binding upload and applies
        // them at runtime, but never echoes them from `/settings`.
        return script
          ? cfSuccess({
              bindings: script.bindings.map((binding) => {
                if (binding.type !== 'service') {
                  return binding;
                }
                const { props: _props, ...rest } = binding;
                return { ...rest, environment: 'production' };
              }),
            })
          : Response.json(
              { success: false, errors: [{ code: 10007, message: 'script not found' }] },
              { status: 404 },
            );
      }
      if (method === 'POST' && url.endsWith('/subdomain')) {
        return cfSuccess({ enabled: false });
      }
      if (method === 'PUT') {
        return mocks.uploadWorker(url, init);
      }
      if (method === 'DELETE') {
        return mocks.deleteWorker(url, init);
      }
    }
    if (method === 'PUT' && url.includes('/workers/dispatch/') && url.includes('/secrets')) {
      return mocks.setWorkerSecret(url, init);
    }
    if (method === 'DELETE' && url.includes('/workers/dispatch/') && url.includes('/secrets/')) {
      return mocks.deleteWorkerSecret(url, init);
    }
    if (method === 'GET' && url.includes('/workers/dispatch/') && url.includes('/bindings')) {
      return mocks.listWorkerBindings(url, init);
    }
    if (method === 'PATCH' && url.includes('/workers/dispatch/') && url.endsWith('/settings')) {
      return mocks.patchScriptSettings!(url, init);
    }
    // GET on a dispatch script (no /bindings, no /secrets) — read the
    // script's metadata + migration_tag. Must come AFTER /bindings and
    // /secrets matches because those URLs share the prefix.
    if (
      method === 'GET' &&
      /\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/?#]+(?:[?#]|$)/.test(url)
    ) {
      return mocks.getDispatchScript!(url, init);
    }
    if (method === 'DELETE' && url.includes('/workers/dispatch/')) {
      return mocks.deleteWorker(url, init);
    }
    if (method === 'PUT' && url.includes('/workers/dispatch/')) {
      return mocks.uploadWorker(url, init);
    }
    if (method === 'DELETE' && url.includes('/d1/database/')) {
      return mocks.deleteD1(url, init);
    }
    if (method === 'PUT' && url.includes('/d1/database/')) {
      return Response.json({ success: true, errors: [], result: {} });
    }
    if (method === 'DELETE' && url.includes('/storage/kv/namespaces/')) {
      return mocks.deleteKV(url, init);
    }
    if (method === 'DELETE' && url.includes('/r2/buckets/')) {
      return mocks.deleteR2(url, init);
    }
    if (method === 'POST' && url.includes('/d1/database/') && url.includes('/query')) {
      return mocks.queryD1(url, init);
    }
    if (method === 'POST' && url.includes('/d1/database')) {
      return mocks.createD1(url, init);
    }
    if (method === 'POST' && url.includes('/storage/kv/namespaces')) {
      return mocks.createKV(url, init);
    }
    if (method === 'POST' && url.includes('/r2/buckets')) {
      return mocks.createR2(url, init);
    }
    if (method === 'POST' && url.includes('/queues/') && url.includes('/consumers')) {
      return mocks.addQueueConsumer(url, init);
    }
    if (method === 'GET' && url.includes('/queues/') && url.includes('/consumers')) {
      return mocks.listQueueConsumers(url, init);
    }
    if (method === 'PUT' && url.includes('/queues/') && url.includes('/consumers/')) {
      return mocks.updateQueueConsumer(url, init);
    }
    if (method === 'POST' && url.includes('/queues')) {
      return mocks.createQueue(url, init);
    }
    if (method === 'DELETE' && url.includes('/queues/')) {
      return mocks.deleteQueue(url, init);
    }

    throw new Error(`Unmocked fetch: ${method} ${url}`);
  });

  vi.stubGlobal('fetch', fn);

  const seedHostScript: MockCfApiHandle['seedHostScript'] = (args) => {
    const classes = new Map<string, string>();
    if (args.classes) {
      for (const [k, v] of Object.entries(args.classes)) {
        classes.set(k, v);
      }
    }
    const bindings = (args.bindings ?? []) as SandboxMockHostScript['bindings'];
    const script: SandboxMockHostScript = {
      migration_tag: args.migrationTag,
      classes,
      bindings,
      metadata: args.metadata ?? {},
    };
    state.hostScripts.set(args.scriptName, script);
    return script;
  };

  const seedContainerApp: MockCfApiHandle['seedContainerApp'] = (args) => {
    const app: SandboxMockContainerApp = {
      id: `app_${args.name}`,
      name: args.name,
      scheduling_policy: 'default',
      configuration: {
        image: args.image,
        instance_type: args.instanceType ?? 'lite',
      },
      max_instances: args.maxInstances ?? 20,
      durable_objects: { namespace_id: args.namespaceId },
    };
    state.containerApps.set(app.id, app);
    return app;
  };

  const expectCallOrder: MockCfApiHandle['expectCallOrder'] = (...steps) => {
    let cursor = 0;
    for (const step of steps) {
      const matchAt = state.recordedCalls.findIndex((c, i) => {
        if (i < cursor) {
          return false;
        }
        if (typeof step === 'string') {
          return c.url.includes(step);
        }
        return c.method === step.method && c.url.includes(step.url);
      });
      if (matchAt === -1) {
        const recorded = state.recordedCalls.map((c) => `${c.method} ${c.url}`).join('\n');
        const stepStr = typeof step === 'string' ? step : `${step.method} ${step.url}`;
        throw new Error(
          `expectCallOrder: did not find step "${stepStr}" after index ${cursor}.\nRecorded calls:\n${recorded}`,
        );
      }
      cursor = matchAt + 1;
    }
  };

  const handle = Object.assign(fn, {
    state,
    seedHostScript,
    seedContainerApp,
    expectCallOrder,
  }) as MockCfApiHandle;
  return handle;
}

export async function readAllEvents(res: Response): Promise<Array<unknown>> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
