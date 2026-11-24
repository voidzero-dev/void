/**
 * `void project security check` (design doc 0095 M32): a security scan of this
 * folder's code before it is deployed.
 *
 *   git ls-files ─► filter (same rules as the platform) ─► secret-like: never sent
 *                                                      └► lockfiles, binaries: never sent
 *   the rest, as it is on disk ─► tar + gzip ─► preview (model, notice, cost) ─► confirm
 *   ─► create (one presigned upload) ─► PUT to storage ─► start ─► poll ─► print
 *
 * Only git-tracked files leave the machine. The result is not saved as project
 * findings; the platform keeps it 30 days.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  isSecurityLocalTreePath,
  SECURITY_LOCAL_CHECK_LIMITS,
  securityInputFilter,
  securityLocalTreeTar,
} from '@void/platform/security-local-check';
import type { SecurityLocalTreeFile } from '@void/platform/security-local-check';
import { join } from 'pathslash';
import type { PlatformClient } from './client.ts';
import { DirectR2PutError, uploadAssetsToR2 } from './direct-r2-upload.ts';
import type { SecurityCheckFinding, SecurityCheckView } from './security-api-types.ts';

/** Secret-like file names listed before the upload, at most. */
const LISTED_SECRET_FILES = 5;
/** How often the CLI asks for the result, and for how long. */
export const SECURITY_CHECK_POLL_MS = 5000;
export const SECURITY_CHECK_WAIT_MS: number = 60 * 60_000;
const ENDED_WITH_RESULT = new Set(['succeeded', 'incomplete']);

export type SecurityLocalTree = {
  files: Array<SecurityLocalTreeFile>;
  bytes: number;
  /** Secret-like files, never sent. */
  secret: Array<string>;
  /** Lockfiles, generated files, binaries and media, never sent. */
  skipped: number;
};

/** Tracked files under `root`, relative to it (git prints them so with `-z`, unquoted). */
function listTrackedFiles(root: string): Array<string> {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--', '.'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter((path) => path.length > 0);
  } catch {
    throw new Error(
      'project: void project security check sends only git-tracked files, and this folder is not in a git repository. Run `git init` and `git add` your code first.',
    );
  }
}

const NUL_SNIFF_BYTES = 8192;

function hasNul(data: Uint8Array): boolean {
  const end = Math.min(data.length, NUL_SNIFF_BYTES);
  for (let index = 0; index < end; index++) {
    if (data[index] === 0) {
      return true;
    }
  }
  return false;
}

/** The first bytes of a file, to tell a binary without reading all of it. */
function readHead(full: string): Uint8Array {
  const fd = openSync(full, 'r');
  try {
    const head = new Uint8Array(NUL_SNIFF_BYTES);
    return head.subarray(0, readSync(fd, head, 0, NUL_SNIFF_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

const MB = 1024 * 1024;

function tooManyFiles(count: number): Error {
  const max = SECURITY_LOCAL_CHECK_LIMITS.maxFiles;
  return new Error(
    `project: A security check sends at most ${max.toLocaleString('en-US')} files, and this folder has ${count.toLocaleString('en-US')} or more. Run it from the app's folder.`,
  );
}

function tooManyBytes(bytes: number): Error {
  return new Error(
    `project: A security check sends at most ${SECURITY_LOCAL_CHECK_LIMITS.maxBytes / MB} MB of code, and this folder has ${(bytes / MB).toFixed(1)} MB or more. Run it from the app's folder.`,
  );
}

/**
 * A tracked file to send: `null` when there is nothing to send (deleted, a submodule
 * folder, a symlink, unreadable, a binary over the room left), its `size` when it is
 * bigger than `room`, known from its size on disk before the file is read.
 */
function readTrackedFile(full: string, room: number): Uint8Array | null | { size: number } {
  try {
    const stat = lstatSync(full);
    if (!stat.isFile()) {
      return null;
    }
    if (stat.size > room) {
      // A binary is never sent, so it does not count; anything else is too large.
      return hasNul(readHead(full)) ? null : { size: stat.size };
    }
    return readFileSync(full);
  } catch {
    return null;
  }
}

/**
 * The git-tracked files under `root`, as they are on disk now (edits included), with
 * the files the platform would never read left out. Throws past the check's limits,
 * from the sizes on disk, before a file over them is read.
 */
export function collectSecurityLocalTree(
  root: string,
  listFiles: (root: string) => Array<string> = listTrackedFiles,
): SecurityLocalTree {
  const tree: SecurityLocalTree = { files: [], bytes: 0, secret: [], skipped: 0 };
  const limits = SECURITY_LOCAL_CHECK_LIMITS;
  for (const path of listFiles(root)) {
    const filter = securityInputFilter(path);
    if (filter === 'secret') {
      tree.secret.push(path);
      continue;
    }
    if (filter === 'skipped' || !isSecurityLocalTreePath(path)) {
      tree.skipped++;
      continue;
    }
    const data = readTrackedFile(join(root, path), limits.maxBytes - tree.bytes);
    if (data === null) {
      tree.skipped++;
      continue;
    }
    if (!(data instanceof Uint8Array)) {
      throw tooManyBytes(tree.bytes + data.size);
    }
    if (hasNul(data)) {
      tree.skipped++;
      continue;
    }
    if (tree.files.length >= limits.maxFiles) {
      throw tooManyFiles(tree.files.length + 1);
    }
    tree.files.push({ path, data });
    tree.bytes += data.length;
  }
  if (tree.bytes > limits.maxBytes) {
    // A file grew between its size and its read.
    throw tooManyBytes(tree.bytes);
  }
  return tree;
}

export type SecurityPackedTree = {
  archive: Buffer;
  request: { files: number; bytes: number; size: number; md5: string };
};

export function packSecurityLocalTree(tree: SecurityLocalTree): SecurityPackedTree {
  const archive = gzipSync(securityLocalTreeTar(tree.files));
  return {
    archive,
    request: {
      files: tree.files.length,
      bytes: tree.bytes,
      size: archive.length,
      md5: createHash('md5').update(archive).digest('hex'),
    },
  };
}

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / MB).toFixed(1)} MB`;
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

/** What is sent and what is not, before the question. */
export function checkSummaryLines(
  slug: string,
  tree: SecurityLocalTree,
  clean: (value: unknown) => string,
): Array<string> {
  const lines = [
    `Security check of ${slug}: ${plural(tree.files.length, 'git-tracked file')} (${size(tree.bytes)}) from this folder.`,
  ];
  if (tree.secret.length > 0) {
    const shown = tree.secret.slice(0, LISTED_SECRET_FILES).map(clean).join(', ');
    const more =
      tree.secret.length > LISTED_SECRET_FILES
        ? `, and ${tree.secret.length - LISTED_SECRET_FILES} more`
        : '';
    lines.push(`  Not sent: ${plural(tree.secret.length, 'secret-like file')} (${shown}${more}).`);
  }
  if (tree.skipped > 0) {
    lines.push(
      `  Not sent: ${plural(tree.skipped, 'other file')} (lockfiles, generated files, binaries, media).`,
    );
  }
  lines.push('  Untracked files are not sent. Add them with git add to include them.');
  return lines;
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  informational: 'INFO',
};

function where(finding: SecurityCheckFinding, clean: (value: unknown) => string): string {
  return `${clean(finding.file)}${finding.lineStart === null ? '' : `:${finding.lineStart}`}`;
}

/**
 * The ended check: one line per finding, confirmed first, then leads. `fresh`: the
 * check just ran, so a missing result is a fault, not the 30-day limit.
 */
export function checkResultLines(
  slug: string,
  view: SecurityCheckView,
  clean: (value: unknown) => string,
  options: { fresh?: boolean } = {},
): Array<string> {
  const { check, result } = view;
  const head = [
    `${slug} · local check ${clean(check.id)}`,
    `  ${clean(check.status)}${check.statusReason ? ` (${clean(check.statusReason)})` : ''}${check.coverageLabel ? ` · ${clean(check.coverageLabel)}` : ''} · ${plural(check.filesScanned, 'file')}${check.model ? ` · ${clean(check.model)}` : ''}`,
  ];
  if (!ENDED_WITH_RESULT.has(check.status)) {
    return head;
  }
  if (result === null) {
    return [
      ...head,
      options.fresh
        ? '  The result is missing.'
        : '  The result is no longer stored (results are kept for 30 days).',
    ];
  }
  const confirmed = result.findings.filter((finding) => finding.verdict === 'confirmed');
  const leads = result.findings.filter((finding) => finding.verdict !== 'confirmed');
  const lines = [...head];
  if (result.findings.length === 0) {
    lines.push('  No security issues found.');
  } else {
    const bySeverity = new Map<string, number>();
    for (const finding of confirmed) {
      const key = finding.severity ?? 'informational';
      bySeverity.set(key, (bySeverity.get(key) ?? 0) + 1);
    }
    const counts = [...bySeverity.entries()]
      .map(([severity, count]) => `${count} ${severity}`)
      .join(', ');
    lines.push(
      `  ${plural(confirmed.length, 'finding')}${counts ? ` (${counts})` : ''} · ${plural(leads.length, 'lead')}`,
    );
    for (const finding of confirmed) {
      lines.push(
        `  ${(SEVERITY_LABEL[finding.severity ?? ''] ?? 'INFO').padEnd(9)} ${clean(finding.title)}`,
        `  ${' '.repeat(9)} ${where(finding, clean)}`,
      );
    }
    for (const finding of leads) {
      lines.push(
        `  ${'LEAD'.padEnd(9)} ${clean(finding.title)}`,
        `  ${' '.repeat(9)} ${where(finding, clean)}`,
      );
    }
    if (result.capped) {
      lines.push(`  Showing ${result.findings.length} of ${result.total}.`);
    }
  }
  if (check.status === 'incomplete') {
    lines.push('  The check stopped early: only confirmed findings it reached are listed.');
  }
  lines.push(
    '  Not saved as project findings. The platform keeps this result for 30 days. Details: --json',
  );
  return lines;
}

/** Why an ended check has no result, and what to do. */
export function checkFailureMessage(
  view: SecurityCheckView,
  clean: (value: unknown) => string,
  options: { fresh?: boolean } = {},
): string {
  const { check } = view;
  const reason = clean(check.statusReason ?? 'unknown');
  switch (check.status) {
    case 'succeeded':
    case 'incomplete':
      return options.fresh
        ? 'project: The check ended, but its result could not be read. Run it again.'
        : 'project: The result of this check is no longer stored (results are kept for 30 days). Run a new check.';
    case 'refused':
      return `project: The check was refused by ${clean(check.model ?? 'the scan model')} (category: ${clean(check.refusalCategory ?? 'unknown')}). Pick another model with void project security model <id>, then run the check again.`;
    case 'timed_out':
      return 'project: The check timed out. Run it again, or from a smaller folder.';
    case 'skipped':
      return reason === 'budget'
        ? 'project: The check did not run: the monthly scan budget is used up.'
        : `project: The check did not run (${reason}).`;
    case 'canceled':
      return reason === 'upload_replaced'
        ? 'project: The check was replaced by a newer one before its code was uploaded.'
        : `project: The check was canceled (${reason}).`;
    default:
      return check.failureCause === 'installation'
        ? 'project: The check failed because of a platform problem. Your platform admin can see it in the admin panel.'
        : `project: The check failed (${reason}). Run it again.`;
  }
}

export type SecurityCheckDeps = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fetch?: typeof fetch;
  listFiles?: (root: string) => Array<string>;
};

/** Upload, start, and return the check id. */
export async function sendSecurityLocalCheck(
  client: PlatformClient,
  projectId: string,
  packed: SecurityPackedTree,
  deps: SecurityCheckDeps = {},
): Promise<string> {
  const created = await client.createProjectSecurityCheck(projectId, packed.request);
  try {
    await uploadAssetsToR2(
      [
        {
          path: 'security check archive',
          hash: packed.request.md5,
          body: packed.archive,
          url: created.upload.url,
          headers: created.upload.headers,
        },
      ],
      undefined,
      deps.fetch ?? fetch,
    );
  } catch (error) {
    // The upload is signed `If-None-Match: *`: a 412 on a retry means an earlier PUT
    // landed and only its reply was lost. Start checks the archive is there.
    if (!(error instanceof DirectR2PutError && error.status === 412)) {
      throw error;
    }
  }
  await client.startProjectSecurityCheck(projectId, created.checkId);
  return created.checkId;
}

/**
 * Polls until the check ends or the wait is over. `onState` hears each new state
 * (queued, running) once. `null` when the wait ran out.
 */
export async function waitForSecurityLocalCheck(
  client: PlatformClient,
  projectId: string,
  checkId: string,
  onState: (status: string) => void,
  deps: SecurityCheckDeps = {},
): Promise<SecurityCheckView | null> {
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((done) => {
        setTimeout(done, ms);
      }));
  const now = deps.now ?? Date.now;
  const until = now() + SECURITY_CHECK_WAIT_MS;
  let last = '';
  for (;;) {
    const view = await client.getProjectSecurityCheck(projectId, checkId);
    if (view.ended) {
      return view;
    }
    if (view.check.status !== last) {
      last = view.check.status;
      onState(last);
    }
    if (now() >= until) {
      return null;
    }
    await sleep(SECURITY_CHECK_POLL_MS);
  }
}

export function checkEndedWithResult(view: SecurityCheckView): boolean {
  return ENDED_WITH_RESULT.has(view.check.status) && view.result !== null;
}
