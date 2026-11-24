/**
 * The input of a local check (`void project security check`, design doc 0095 M32).
 * The CLI uploaded the project's git-tracked files as one gzip tar
 * (`@void/platform/security-local-check`); this reads it once the scan runs:
 *
 *   fence (running, this attempt, trigger local)
 *   local-tree.tar.gz ─► walk (file and byte limits) ─► source files, priority order
 *     └ missing or broken ─► failed (input_missing)
 *   build: a full scan (no base, no backlog, no runtime copy), secrets redacted,
 *   memory of past findings as read-only context
 *   row update ─► tar stream for the container
 *
 * Nothing here touches the project's findings, backlog or base snapshot: a local
 * check is a separate result (R13). The uploaded tree stays until the check ends, so
 * a retry can read it again; `local-check.ts` deletes it then.
 */
import { SECURITY_LOCAL_CHECK_LIMITS } from '@void/platform/security-local-check';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db.ts';
import { pokeSecurityScanScheduler } from '../enqueue.ts';
import { securityLocalTreeKey } from '../local-check.ts';
import { securityRawOutputPrefix } from '../maintenance.ts';
import { endSecurityScanAttempt } from '../queue.ts';
import { securityScans } from '../schema.ts';
import { buildSecurityScanInput } from './build.ts';
import type { SecurityBuiltInput } from './build.ts';
import type { SecurityInputEnv, SecurityPreparedInput } from './prepare.ts';
import { loadSecurityMemory, loadSecuritySecrets } from './project-data.ts';
import { SourceTarballError, walkSourceTarball } from './source-tar.ts';
import { securityRepoRank } from './t1.ts';
import { sha256Hex } from './t2.ts';
import type { SecuritySourceFile } from './t2.ts';
import { assertTarEntries } from './tar.ts';
import { chooseSecurityTier } from './tier.ts';

/** Folder names that hold server code in a Void app: read first (spec §7.4, T1 order). */
const SERVER_SEGMENTS = new Set(['routes', 'server', 'api', 'middleware', 'functions']);

/** Priority of a working-tree file: server code, then config, other code, tests and docs. */
export function securityLocalRank(path: string): number {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const name = segments.at(-1) ?? '';
  if (
    segments.slice(0, -1).some((segment) => SERVER_SEGMENTS.has(segment)) ||
    name.includes('.server.')
  ) {
    const rank = securityRepoRank(path);
    // A test under `routes/` is still a test.
    return rank === 3 ? 3 : 0;
  }
  return securityRepoRank(path);
}

/** Files read from the archive, in priority order (then by path, so the order is stable). */
export function orderLocalSources(
  files: ReadonlyArray<SecuritySourceFile>,
): Array<SecuritySourceFile> {
  return [...files].sort(
    (a, b) =>
      securityLocalRank(a.path) - securityLocalRank(b.path) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

type LocalContext = Readonly<{
  id: string;
  projectId: string;
  attempt: number;
  engine: NonNullable<typeof securityScans.$inferSelect.engine>;
  model: string;
}>;

async function loadLocalContext(
  db: Db,
  scanId: string,
  attempt: number,
): Promise<LocalContext | null> {
  const [row] = await db
    .select({
      id: securityScans.id,
      projectId: securityScans.project_id,
      trigger: securityScans.trigger,
      status: securityScans.status,
      attempt: securityScans.attempt,
      engine: securityScans.engine,
      model: securityScans.model_used,
    })
    .from(securityScans)
    .where(eq(securityScans.id, scanId))
    .limit(1);
  if (
    !row ||
    row.trigger !== 'local' ||
    row.status !== 'running' ||
    row.attempt !== attempt ||
    row.engine === null ||
    row.model === null
  ) {
    return null;
  }
  return { id: row.id, projectId: row.projectId, attempt, engine: row.engine, model: row.model };
}

const decoder = new TextDecoder();

/** The uploaded tree's files; `null` when it is gone or cannot be read. */
async function readLocalTree(r2: R2Bucket, key: string): Promise<Array<SecuritySourceFile> | null> {
  const object = await r2.get(key);
  if (!object) {
    return null;
  }
  const files = new Map<string, SecuritySourceFile>();
  try {
    await walkSourceTarball(
      object.body as ReadableStream<Uint8Array>,
      {
        maxFiles: SECURITY_LOCAL_CHECK_LIMITS.maxFiles,
        maxBytes: SECURITY_LOCAL_CHECK_LIMITS.maxBytes,
      },
      (entry) => {
        const parts: Array<Uint8Array> = [];
        return (chunk) => {
          if (chunk !== null) {
            parts.push(chunk.slice());
            return;
          }
          const bytes = new Uint8Array(entry.size);
          let at = 0;
          for (const part of parts) {
            bytes.set(part, at);
            at += part.length;
          }
          // A path listed twice: the later entry is what extraction would leave.
          files.set(entry.path, {
            path: entry.path,
            text: decoder.decode(bytes),
            sha256: sha256Hex(bytes),
            module: '',
            map: null,
            built: false,
          });
        };
      },
    );
  } catch (error) {
    if (error instanceof SourceTarballError) {
      console.warn('[security-scan] local tree cannot be read', { key, reason: error.message });
      return null;
    }
    throw error;
  }
  return [...files.values()];
}

/**
 * Builds and records the input of one running local check attempt. `null` when the
 * attempt is not the running one, or the tree is missing (the row then ends
 * `failed (input_missing)`). A tree with no file left to read is an empty focus: no
 * model runs and the check succeeds with nothing to report.
 */
export async function prepareLocalCheckInputFiles(
  env: SecurityInputEnv,
  db: Db,
  scanId: string,
  attempt: number,
): Promise<SecurityPreparedInput | null> {
  const scan = await loadLocalContext(db, scanId, attempt);
  if (!scan) {
    return null;
  }
  const r2 = env.STATIC_ASSETS_R2;
  const sources = await readLocalTree(r2, securityLocalTreeKey(scan.projectId, scan.id));
  if (sources === null) {
    const ended = await endSecurityScanAttempt(db, scanId, attempt, {
      status: 'failed',
      reason: 'input_missing',
      errorClass: 'input_missing',
      failureCause: 'project',
    });
    if (ended) {
      await pokeSecurityScanScheduler(env);
    }
    return null;
  }
  const memory = await loadSecurityMemory(db, scan.projectId);
  const secrets = await loadSecuritySecrets(env, db, scan.projectId);
  const built: SecurityBuiltInput = buildSecurityScanInput({
    scan: {
      id: scan.id,
      attempt: scan.attempt,
      engine: scan.engine,
      model: scan.model,
      trigger: 'local',
      commit: null,
    },
    tier: chooseSecurityTier({ trigger: 'local', baseDeploymentId: null, baseSnapshot: false }),
    head: { modules: [], main: null },
    bundle: { files: orderLocalSources(sources), noSourceMaps: 0, moduleSources: new Map() },
    base: null,
    assets: [],
    backlog: [],
    recheckFiles: [],
    secrets,
    lockfile: null,
    memory: {
      findings: memory.findings,
      events: memory.events,
      lastSucceededAt: null,
      ledgerSummary: null,
    },
  });
  assertTarEntries(built.entries);
  // What ingest reads back: the server's own leads (secret values found in the tree,
  // text aimed at reviewers). No backlog or scope file: nothing moves for the project.
  await r2.put(
    `${securityRawOutputPrefix(scan.projectId, scan.id)}server-leads.json`,
    JSON.stringify({ version: 1, leads: built.serverLeads }),
  );
  const recorded = await db
    .update(securityScans)
    .set({
      tier: built.tier,
      coverage: built.coverage,
      coverage_notes: [...built.notes],
      // A local check leaves no backlog: files it could not read are only counted.
      backlog_files: 0,
      dropped_files: built.droppedFiles,
      dropped_bytes: built.droppedBytes,
      files_scanned: built.filesScanned,
      input_bytes: built.inputBytes,
    })
    .where(
      and(
        eq(securityScans.id, scan.id),
        eq(securityScans.status, 'running'),
        eq(securityScans.attempt, scan.attempt),
      ),
    )
    .returning({ id: securityScans.id });
  if (recorded.length === 0) {
    return null;
  }
  return {
    // Nothing readable (every file filtered out): no model call, nothing found.
    built: built.filesScanned === 0 ? { ...built, emptyFocus: true, noChanges: false } : built,
    baseScanId: null,
    baseDeploymentId: null,
  };
}
