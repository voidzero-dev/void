/**
 * Focus caps and the unscanned backlog (spec §7.4, edges #13, #36).
 *
 * A scan sends at most 400 changed files, 2 MB in all, as its focus. Each later scan
 * takes up to 400 files from the project's backlog first, then the new diff; the
 * rest goes (back) to the backlog. A file over 256 KB counts as 256 KB: only part
 * of it fits in the model's view anyway.
 *
 * The backlog is `security-scans/{project}/backlog.json`. A scan writes the backlog
 * it leaves behind next to its raw output; ingest (M12) makes it the project's
 * backlog only when the scan succeeds, so a failed scan loses no file.
 */
import { assertTarPath } from './tar.ts';

export const SECURITY_FOCUS_MAX_FILES = 400;
export const SECURITY_FOCUS_MAX_BYTES = 2 * 1024 * 1024;
export const SECURITY_FILE_MAX_BYTES = 256 * 1024;
/** A backlog longer than this is cut (oldest kept): it is drained 400 files a scan. */
export const SECURITY_BACKLOG_MAX_PATHS = 50_000;

export type SecurityFocusCandidate = Readonly<{ path: string; bytes: number }>;

export type SecurityFocus = Readonly<{
  /** Paths sent as focus, backlog first. */
  focus: ReadonlyArray<string>;
  /** Paths left for later scans. */
  backlog: ReadonlyArray<string>;
  /** How many focus paths came from the backlog. */
  fromBacklog: number;
}>;

function weight(bytes: number): number {
  return Math.min(Math.max(bytes, 0), SECURITY_FILE_MAX_BYTES);
}

/**
 * `diff` is in priority order. `available` holds every path in this scan's input
 * with its size: backlog paths no longer in the input (deleted files) are dropped.
 */
export function selectSecurityFocus(
  input: Readonly<{
    backlog: ReadonlyArray<string>;
    diff: ReadonlyArray<SecurityFocusCandidate>;
    available: ReadonlyMap<string, number>;
    maxFiles?: number;
    maxBytes?: number;
  }>,
): SecurityFocus {
  const maxFiles = input.maxFiles ?? SECURITY_FOCUS_MAX_FILES;
  const maxBytes = input.maxBytes ?? SECURITY_FOCUS_MAX_BYTES;
  const focus: Array<string> = [];
  const taken = new Set<string>();
  const left: Array<string> = [];
  const leftSet = new Set<string>();
  let bytes = 0;
  let fromBacklog = 0;

  const offer = (path: string, size: number, isBacklog: boolean) => {
    if (taken.has(path) || leftSet.has(path)) {
      return;
    }
    const cost = weight(size);
    if (focus.length < maxFiles && bytes + cost <= maxBytes) {
      focus.push(path);
      taken.add(path);
      bytes += cost;
      if (isBacklog) {
        fromBacklog++;
      }
      return;
    }
    left.push(path);
    leftSet.add(path);
  };

  for (const path of input.backlog) {
    const size = input.available.get(path);
    if (size !== undefined) {
      offer(path, size, true);
    }
  }
  for (const candidate of input.diff) {
    offer(candidate.path, candidate.bytes, false);
  }
  return { focus, backlog: left.slice(0, SECURITY_BACKLOG_MAX_PATHS), fromBacklog };
}

export function serializeSecurityBacklog(paths: ReadonlyArray<string>): string {
  return JSON.stringify({ version: 1, paths });
}

/** A missing, unreadable or malformed backlog is empty; bad paths are left out. */
export function parseSecurityBacklog(text: string | null): Array<string> {
  if (text === null) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const { version, paths } = value as { version?: unknown; paths?: unknown };
  if (version !== 1 || !Array.isArray(paths)) {
    return [];
  }
  const out: Array<string> = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== 'string' || seen.has(path)) {
      continue;
    }
    try {
      assertTarPath(path);
    } catch {
      continue;
    }
    seen.add(path);
    out.push(path);
    if (out.length >= SECURITY_BACKLOG_MAX_PATHS) {
      break;
    }
  }
  return out;
}
