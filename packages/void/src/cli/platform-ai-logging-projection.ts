import {
  AI_LOGGING_ORPHAN_GRACE_MS,
  aiLoggingClearedKey,
  aiLoggingClearedMarker,
  aiLoggingKey,
  isPublishedAiLoggingMode,
  parseAiLoggingKeyMetadata,
  parsePlanAiLoggingSettings,
  PLAN_AI_LOGGING_SETTING,
  planAiLogging,
  resolveAiLogging,
  type AiLoggingPlanCatalog,
  type PlanAiLoggingSettings,
} from '@void/platform/ai-logging';
import { createDefaultPlanCatalog, parsePlatformPlanCatalog } from '@void/platform/plans';
import type {
  CloudflareKvBulkEntry,
  CloudflareKvKey,
  PlatformCloudflareClient,
} from './platform-cloudflare.ts';
import type { PlatformDatabaseLifecycleLock } from './platform-installer-types.ts';
import type { QueryConnection } from './platform-zero-trust-uninstall.ts';

const KEY_PREFIX = aiLoggingKey('');
const PLAN_CATALOG_SETTING = 'plans:catalog';
/** Wait at most this long for a project row lock held by the API. */
const LOCK_TIMEOUT = '30s';

/** ROUTING KV access for one installation, bound to its account and namespace. */
export type AiLoggingProjectionKv = Readonly<{
  list: (prefix: string) => Promise<ReadonlyArray<CloudflareKvKey>>;
  put: (entries: ReadonlyArray<CloudflareKvBulkEntry>) => Promise<void>;
  delete: (keys: ReadonlyArray<string>) => Promise<void>;
}>;

export type AiLoggingProjectionResult =
  | Readonly<{ skipped: true }>
  | Readonly<{ skipped: false; projects: number; written: number; deleted: number }>;

type ProjectRow = { id: string; status: string; plan: string; mode: string | null };

type Inputs = Readonly<{
  catalog: AiLoggingPlanCatalog;
  settings: PlanAiLoggingSettings;
}>;

async function readInputs(client: QueryConnection): Promise<Inputs> {
  const result = await client.query<{ key: string; value: unknown }>(
    'SELECT "key", "value" FROM "platform_settings" WHERE "key" = ANY($1::text[])',
    [[PLAN_CATALOG_SETTING, PLAN_AI_LOGGING_SETTING]],
  );
  const saved = new Map(result.rows.map((row) => [row.key, row.value]));
  let catalog: AiLoggingPlanCatalog;
  let settings: PlanAiLoggingSettings;
  try {
    // Installed platforms start with the custom plan as the default (see the API's
    // initialPlanDefaultFor).
    const savedCatalog = saved.get(PLAN_CATALOG_SETTING);
    catalog =
      savedCatalog === undefined || savedCatalog === null
        ? createDefaultPlanCatalog('custom')
        : parsePlatformPlanCatalog(savedCatalog);
    settings = parsePlanAiLoggingSettings(saved.get(PLAN_AI_LOGGING_SETTING));
  } catch (error) {
    throw new Error(
      `platform: The saved plan settings are not valid for this platform version, so AI logging settings cannot be published. If a newer platform release saved them, upgrade to that release again. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return { catalog, settings };
}

function effectiveMode(row: ProjectRow, inputs: Inputs) {
  if (row.mode !== null && !isPublishedAiLoggingMode(row.mode)) {
    throw new Error(`platform: Project ${row.id} has an invalid saved AI logging setting.`);
  }
  const plan = planAiLogging(inputs.settings, inputs.catalog, row.plan);
  return resolveAiLogging(row.mode, plan.planMode).mode;
}

/**
 * The database server's clock in ms. Readback and the sweep compare `at` with the
 * API's clock, so it must not come from the operator's machine.
 */
async function databaseNow(client: QueryConnection): Promise<number> {
  const result = await client.query<{ now: unknown }>(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS "now"',
  );
  const now = Number(result.rows[0]?.now);
  if (!Number.isSafeInteger(now)) {
    throw new Error('platform: The database did not return its current time.');
  }
  return now;
}

const PROJECT_ROWS = `SELECT p."id", p."status", u."plan", o."mode"
  FROM "projects" AS p
  JOIN "users" AS u ON u."id" = p."user_id"
  LEFT JOIN "project_ai_logging" AS o ON o."project_id" = p."id"`;

/**
 * Publishes every project's effective AI logging mode to ROUTING KV from Postgres,
 * the same values the API publishes. The installer runs it on every install, upgrade
 * and repair, once before the Workers upload (a new proxy may go live before the new
 * API) and once after (the old API may have saved changes meanwhile).
 *
 * It holds the project row locks the API publisher takes while it reads the inputs
 * and writes KV, so it never overwrites a newer value the API published. Running it
 * again changes nothing.
 */
export async function projectPlatformAiLoggingConnection(
  client: QueryConnection,
  kv: AiLoggingProjectionKv,
  options: Readonly<{
    /** Overrides the database clock (tests). */
    now?: () => number;
    onProgress?: (message: string) => void;
  }> = {},
): Promise<AiLoggingProjectionResult> {
  const tables = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.project_ai_logging') IS NOT NULL AS "present"`,
  );
  if (tables.rows[0]?.present !== true) {
    // Older schema (or a rollback runtime before 1.8.0): nothing is saved yet.
    return { skipped: true };
  }
  const listed = new Map<string, CloudflareKvKey>();
  for (const key of await kv.list(KEY_PREFIX)) {
    if (key.name.startsWith(KEY_PREFIX) && key.name.length > KEY_PREFIX.length) {
      listed.set(key.name.slice(KEY_PREFIX.length), key);
    }
  }

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    // Pick candidates: projects with an override, projects whose plan has a default,
    // and projects that already have a key (so stale keys are removed).
    const before = await readInputs(client);
    const rows = (await client.query<ProjectRow>(PROJECT_ROWS)).rows;
    const candidates = rows
      .filter(
        (row) =>
          row.mode !== null || listed.has(row.id) || effectiveMode(row, before) !== 'inherit',
      )
      .map((row) => row.id);
    options.onProgress?.(`Publishing AI logging settings (${candidates.length} projects)`);
    // Same lock as the API publisher's no-op UPDATE (so rows that reference a project
    // can still be inserted), taken in id order. Inputs are read again after the
    // locks are held, so a change the API committed meanwhile is the one written.
    if (candidates.length > 0) {
      await client.query(
        'SELECT "id" FROM "projects" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE',
        [candidates],
      );
    }
    const inputs = await readInputs(client);
    const locked = new Set(candidates);
    const current = new Map(
      (
        await client.query<ProjectRow>(`${PROJECT_ROWS} WHERE p."id" = ANY($1::text[])`, [
          candidates,
        ])
      ).rows.map((row) => [row.id, row]),
    );
    const at = options.now ? options.now() : await databaseNow(client);
    const writes: Array<CloudflareKvBulkEntry> = [];
    const deletes: Array<string> = [];
    let markers = 0;
    for (const id of locked) {
      const row = current.get(id);
      if (!row) {
        continue;
      }
      if (row.status !== 'active') {
        // Deletion is in progress; its cleanup job removes the key.
        continue;
      }
      const mode = effectiveMode(row, inputs);
      if (mode !== 'inherit') {
        writes.push({ key: aiLoggingKey(id), value: mode, metadata: { mode, at } });
      } else if (listed.has(id)) {
        // The marker lets readback report `pending` while the old value may linger.
        const marker = aiLoggingClearedMarker(at);
        writes.push({
          key: aiLoggingClearedKey(id),
          value: marker.value,
          metadata: marker.metadata,
          expiration_ttl: marker.expirationTtl,
        });
        markers++;
        deletes.push(aiLoggingKey(id));
      }
    }
    const existing = new Set(rows.map((row) => row.id));
    for (const [id, key] of listed) {
      if (existing.has(id) || current.has(id)) {
        continue;
      }
      // No project row: the project is gone, unless it was created moments ago.
      const metadata = parseAiLoggingKeyMetadata(key.metadata);
      if (!metadata || at - metadata.at >= AI_LOGGING_ORPHAN_GRACE_MS) {
        deletes.push(key.name);
      }
    }
    if (writes.length > 0) {
      await kv.put(writes);
    }
    if (deletes.length > 0) {
      await kv.delete(deletes);
    }
    await client.query('COMMIT');
    return {
      skipped: false,
      projects: locked.size,
      written: writes.length - markers,
      deleted: deletes.length,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Runs the projection through the installer's database lock, with a KV client bound
 * to the installation's ROUTING namespace. A lock without it (test doubles) skips it.
 */
export async function publishInstallationAiLogging(input: {
  readonly client: Pick<PlatformCloudflareClient, 'listKvKeys' | 'putKvBulk' | 'deleteKvBulk'>;
  readonly accountId: string;
  readonly routingKvId: string;
  readonly databaseLock: Pick<PlatformDatabaseLifecycleLock, 'publishAiLogging'>;
  readonly onProgress?: (message: string) => void;
}): Promise<AiLoggingProjectionResult | null> {
  const publish = input.databaseLock.publishAiLogging;
  if (!publish) {
    return null;
  }
  const { client, accountId, routingKvId } = input;
  input.onProgress?.('Publishing AI logging settings');
  return publish(
    {
      list: (prefix) => client.listKvKeys(accountId, routingKvId, prefix),
      put: (entries) => client.putKvBulk(accountId, routingKvId, entries),
      delete: (keys) => client.deleteKvBulk(accountId, routingKvId, keys),
    },
    input.onProgress,
  );
}
