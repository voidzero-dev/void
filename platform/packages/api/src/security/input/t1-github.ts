/**
 * The GitHub and R2 side of the T1 source diff (design doc 0095, M11). Called by
 * `prepare.ts` at scan start, once the base snapshot is known to exist:
 *
 *   managedBuilds? connection? base and head commit? build? ─► start (t1.ts)
 *   scoped installation token (this repository, contents: read)
 *   compare(base...head) ─► ahead / identical, not truncated
 *   head tarball ─► R2 (`…/scans/{scan}/source-{attempt}-{uuid}.tar.gz`, multipart, 100 MB)
 *     pass 1: path, size, sha256 of each file ─► map the bundle, content check, plan
 *     pass 2: the planned files' text
 *   the tarball is deleted when the input is built (a retry fetches it again)
 *
 * Anything that fails here falls back to T2 with a coverage note; it never fails
 * the scan.
 */
import { createHash } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import { getPlatformCapabilities } from '../../capabilities.ts';
import type { Db } from '../../db.ts';
import { installationCoversRepo } from '../../db/github.ts';
import type { ApiEnv } from '../../env.ts';
import {
  compareCommits,
  generateSourceTarballUrl,
  getInstallationToken,
  GITHUB_API_VERSION,
} from '../../github/installation-token.ts';
import { builds, deploymentOperations, deployments, githubConnections } from '../../schema.ts';
import { securityRawOutputPrefix } from '../maintenance.ts';
import type { SecuritySourceDiffInput } from './build.ts';
import { SourceTarballError, SourceTarballTooLarge, walkSourceTarball } from './source-tar.ts';
import {
  claimedCommitMismatch,
  comparisonChangedPaths,
  mapBundleToRepo,
  pickSecurityLockfile,
  planSecuritySourceDiff,
  SECURITY_T1_NOTES,
  securityCompareProblem,
  startSecuritySourceDiff,
} from './t1.ts';
import type { SecurityHeadBuild, SecurityRepoFile, SecurityT1Fallback } from './t1.ts';
import { changedSources, sha256Hex } from './t2.ts';
import type { SecurityBundleSources, SecuritySourceFile } from './t2.ts';
import { parseSecurityLockfile } from './third-party.ts';

export type SecuritySourceDiffEnv = Pick<
  ApiEnv['Bindings'],
  'STATIC_ASSETS_R2' | 'PLATFORM_CAPABILITIES' | 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY'
>;

/** The head tarball, compressed, at most. */
export const SECURITY_SOURCE_TARBALL_MAX_BYTES = 100 * 1024 * 1024;
/** Its files, uncompressed, at most … */
export const SECURITY_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
/** … and how many. */
export const SECURITY_SOURCE_MAX_FILES = 100_000;
const COMPARE_TIMEOUT_MS = 15_000;
const TARBALL_TIMEOUT_MS = 60_000;
/** Every R2 multipart part but the last: at least 5 MiB, and all the same size. */
export const SECURITY_SOURCE_TARBALL_PART_BYTES = 8 * 1024 * 1024;
const PART_BYTES = SECURITY_SOURCE_TARBALL_PART_BYTES;

const LIMITS = { maxFiles: SECURITY_SOURCE_MAX_FILES, maxBytes: SECURITY_SOURCE_MAX_BYTES };

type Fallback = SecurityT1Fallback;

function fallback(note: string | null): Fallback {
  return { ok: false, note };
}

async function loadHeadBuild(db: Db, deploymentId: string): Promise<SecurityHeadBuild | null> {
  const [operation] = await db
    .select({ buildId: deploymentOperations.build_id })
    .from(deploymentOperations)
    .where(eq(deploymentOperations.id, deploymentId))
    .limit(1);
  const [build] = await db
    .select({ executor: builds.executor, commitSha: builds.commit_sha })
    .from(builds)
    .where(
      operation?.buildId
        ? or(eq(builds.id, operation.buildId), eq(builds.deployment_id, deploymentId))
        : eq(builds.deployment_id, deploymentId),
    )
    .limit(1);
  return build ?? null;
}

/**
 * Streams the response body into R2 in parts; `false` when it is too large. R2 wants
 * every part but the last to be the same size, so each one is exactly `PART_BYTES`
 * and what is left of a chunk starts the next.
 */
async function storeTarball(r2: R2Bucket, key: string, body: ReadableStream<Uint8Array>) {
  const upload = await r2.createMultipartUpload(key);
  const parts: Array<R2UploadedPart> = [];
  const reader = body.getReader();
  let part = new Uint8Array(PART_BYTES);
  let filled = 0;
  let total = 0;
  const send = async (bytes: Uint8Array) => {
    parts.push(await upload.uploadPart(parts.length + 1, bytes));
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > SECURITY_SOURCE_TARBALL_MAX_BYTES) {
        await reader.cancel();
        await upload.abort();
        return false;
      }
      let at = 0;
      while (at < value.length) {
        const size = Math.min(PART_BYTES - filled, value.length - at);
        part.set(value.subarray(at, at + size), filled);
        filled += size;
        at += size;
        if (filled === PART_BYTES) {
          await send(part);
          part = new Uint8Array(PART_BYTES);
          filled = 0;
        }
      }
    }
    if (filled > 0 || parts.length === 0) {
      await send(part.subarray(0, filled));
    }
    await upload.complete(parts);
    return true;
  } catch (error) {
    await reader.cancel().catch(() => {});
    await upload.abort().catch(() => {});
    throw error;
  }
}

async function fetchTarball(
  r2: R2Bucket,
  key: string,
  token: string,
  repoFullName: string,
  sha: string,
): Promise<string | null> {
  const signal = AbortSignal.timeout(TARBALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(generateSourceTarballUrl(repoFullName, sha), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'void-api',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      signal,
    });
  } catch {
    return SECURITY_T1_NOTES.unavailable;
  }
  if (!res.ok || res.body === null) {
    await res.body?.cancel();
    return SECURITY_T1_NOTES.unavailable;
  }
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > SECURITY_SOURCE_TARBALL_MAX_BYTES) {
    await res.body.cancel();
    return SECURITY_T1_NOTES.tooLarge;
  }
  try {
    return (await storeTarball(r2, key, res.body)) ? null : SECURITY_T1_NOTES.tooLarge;
  } catch {
    return SECURITY_T1_NOTES.unavailable;
  }
}

async function tarballStream(r2: R2Bucket, key: string): Promise<ReadableStream<Uint8Array>> {
  const object = await r2.get(key);
  if (!object) {
    throw new SourceTarballError('the stored source archive is gone');
  }
  return object.body;
}

/** Pass 1: every file's size and sha256, nothing kept. */
async function indexTarball(r2: R2Bucket, key: string): Promise<Map<string, SecurityRepoFile>> {
  const index = new Map<string, SecurityRepoFile>();
  await walkSourceTarball(await tarballStream(r2, key), LIMITS, (entry) => {
    const hash = createHash('sha256');
    return (chunk) => {
      if (chunk !== null) {
        hash.update(chunk);
        return;
      }
      // A path listed twice: the later entry is what extraction would leave.
      index.set(entry.path, { sha256: hash.digest('hex'), size: entry.size });
    };
  });
  return index;
}

/** Pass 2: the text of the wanted files (BOM kept, so the hash stays the bytes'). */
async function readTarballFiles(
  r2: R2Bucket,
  key: string,
  wanted: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  await walkSourceTarball(await tarballStream(r2, key), LIMITS, (entry) => {
    const sha256 = wanted.get(entry.path);
    if (sha256 === undefined) {
      return null;
    }
    const parts: Array<Uint8Array> = [];
    return (chunk) => {
      if (chunk !== null) {
        parts.push(chunk.slice());
        return;
      }
      const bytes = new Uint8Array(entry.size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      // Only the bytes pass 1 hashed: the archive could hold the path twice.
      if (sha256Hex(bytes) === sha256) {
        texts.set(entry.path, new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
      }
    };
  });
  return texts;
}

export type SecuritySourceDiffRequest = Readonly<{
  scanId: string;
  attempt: number;
  projectId: string;
  deploymentId: string;
  baseDeploymentId: string;
  /** The head deployment's claimed commit. */
  headCommit: string | null;
  /**
   * The bundle's sources (`bundleSources`), in import-graph order. Built only once T1
   * can start, so a T2 scan (self-hosted, no connection) never reads them here.
   */
  bundle: () => SecurityBundleSources;
  headModules: ReadonlyMap<string, string>;
  baseModules: ReadonlyMap<string, string>;
  baseSources: ReadonlyMap<string, string> | null;
  /** What the repo files may take of the input, next to everything else. */
  budget: Readonly<{ bytes: number; files: number }>;
}>;

export type SecuritySourceDiffResult =
  | Readonly<{ ok: true; diff: SecuritySourceDiffInput }>
  | SecurityT1Fallback;

/** The T1 input, or why the scan stays on T2 (`note: null` when T1 never applied). */
export async function loadSecuritySourceDiff(
  env: SecuritySourceDiffEnv,
  db: Db,
  request: SecuritySourceDiffRequest,
): Promise<SecuritySourceDiffResult> {
  if (!getPlatformCapabilities(env).managedBuilds) {
    // Self-hosted: GitHub routes need `managedBuilds`, so nothing is asked of GitHub.
    return fallback(null);
  }
  const [connection] = await db
    .select({
      id: githubConnections.id,
      installationId: githubConnections.installation_id,
      repoFullName: githubConnections.repo_full_name,
      repositoryId: githubConnections.repository_id,
    })
    .from(githubConnections)
    .where(eq(githubConnections.project_id, request.projectId))
    .limit(1);
  const [base] = await db
    .select({ commit: deployments.commit })
    .from(deployments)
    .where(
      and(
        eq(deployments.id, request.baseDeploymentId),
        eq(deployments.project_id, request.projectId),
      ),
    )
    .limit(1);
  const start = startSecuritySourceDiff({
    managedBuilds: true,
    connection: connection ?? null,
    baseCommit: base?.commit ?? null,
    headCommit: request.headCommit,
    build: connection ? await loadHeadBuild(db, request.deploymentId) : null,
  });
  if (!start.ok) {
    return start;
  }
  // The same trust rule as a managed build: an active installation that still selects
  // the repository, connected by the project owner or an admin.
  if (
    !(await installationCoversRepo(
      db,
      connection!.id,
      request.projectId,
      start.connection.installationId,
      start.connection.repositoryId,
    ))
  ) {
    return fallback(SECURITY_T1_NOTES.unavailable);
  }

  let token: string;
  try {
    token = await getInstallationToken(env, start.connection.installationId, {
      repositoryIds: [start.connection.repositoryId],
      permissions: { contents: 'read' },
    });
  } catch {
    return fallback(SECURITY_T1_NOTES.unavailable);
  }
  const compare = await compareCommits(
    token,
    start.connection.repoFullName,
    start.base,
    start.head,
    AbortSignal.timeout(COMPARE_TIMEOUT_MS),
  );
  const problem = securityCompareProblem(compare);
  if (problem !== null || compare === null) {
    return fallback(problem);
  }

  const r2 = env.STATIC_ASSETS_R2;
  // One key per call: an older attempt still running, or a retried call, never deletes
  // or overwrites this one's archive. The raw-output sweep removes any left behind.
  const key = `${securityRawOutputPrefix(request.projectId, request.scanId)}source-${request.attempt}-${crypto.randomUUID()}.tar.gz`;
  try {
    const stored = await fetchTarball(r2, key, token, start.connection.repoFullName, start.head);
    if (stored !== null) {
      return fallback(stored);
    }
    const repo = await indexTarball(r2, key);
    const { files: sources, noSourceMaps } = request.bundle();
    const builtChanged = new Set(
      changedSources(
        sources.filter((source) => !source.built),
        request.headModules,
        request.baseModules,
        request.baseSources,
      ).map((source) => source.path),
    );
    const mapping = mapBundleToRepo(sources, repo, start.managed);
    if (!mapping.ok) {
      return mapping;
    }
    const changedRepoPaths = comparisonChangedPaths(compare.files);
    if (
      !start.managed &&
      claimedCommitMismatch({
        mapping,
        changedRepoPaths,
        builtChanged,
        noSourceMaps,
      })
    ) {
      return fallback(SECURITY_T1_NOTES.commitMismatch);
    }
    // Built modules with no map are bundle-only code too; they count as changed by hash.
    for (const source of sources) {
      if (source.built && request.baseModules.get(source.module) !== source.sha256) {
        builtChanged.add(source.path);
      }
    }
    const plan = planSecuritySourceDiff({
      mapping,
      repo,
      managed: start.managed,
      sources,
      changedRepoPaths,
      builtChanged,
      budget: request.budget,
    });
    // The repo lockfile comes along in the same pass: registry packages are dropped by
    // package identity (spec §7.4), never by path text.
    const lockfilePath = pickSecurityLockfile(repo, mapping.root);
    const wanted = new Map(plan.read.map((file) => [file.repoPath, file.sha256]));
    if (lockfilePath !== null) {
      wanted.set(lockfilePath, repo.get(lockfilePath)!.sha256);
    }
    const texts = await readTarballFiles(r2, key, wanted);
    const lockText = lockfilePath === null ? undefined : texts.get(lockfilePath);
    const lockfile =
      lockfilePath === null || lockText === undefined
        ? null
        : parseSecurityLockfile(lockfilePath, lockText);
    const files: Array<SecuritySourceFile> = [];
    const unread = [...plan.unread];
    for (const file of plan.read) {
      const text = texts.get(file.repoPath);
      if (text === undefined) {
        unread.push({ path: file.inputPath, bytes: file.size, sha256: file.sha256 });
        continue;
      }
      files.push({
        path: file.inputPath,
        text,
        sha256: file.sha256,
        module: '',
        map: null,
        built: false,
      });
    }
    files.push(...plan.bundleOnly);
    return {
      ok: true,
      diff: { files, changed: plan.changed, unread, secret: plan.secret, notes: [], lockfile },
    };
  } catch (error) {
    if (error instanceof SourceTarballTooLarge) {
      return fallback(SECURITY_T1_NOTES.tooLarge);
    }
    if (error instanceof SourceTarballError) {
      return fallback(SECURITY_T1_NOTES.unavailable);
    }
    throw error;
  } finally {
    await r2.delete(key).catch(() => {});
  }
}
