/**
 * Focus caps and the unscanned backlog (spec §7.4, edges #13, #36). A scan's focus is at
 * most 400 files, 2 MB (a file counts at most 256 KB): backlog first, then the new diff;
 * the rest goes to the backlog, which ingest keeps only when the scan succeeds.
 */
import { assertTarPath } from './tar.ts';

export const SECURITY_FOCUS_MAX_FILES = 400;
export const SECURITY_FOCUS_MAX_BYTES = 2 * 1024 * 1024;
export const SECURITY_FILE_MAX_BYTES = 256 * 1024;
/** A backlog longer than this is cut (oldest kept): it is drained 400 files a scan. */
export const SECURITY_BACKLOG_MAX_PATHS = 50_000;

export type SecurityFocusCandidate = Readonly<{ path: string; bytes: number }>;

export type SecurityFocus = Readonly<{
  focus: ReadonlyArray<string>;
  backlog: ReadonlyArray<string>;
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
  const left: Array<string> = [];
  const seen = new Set<string>();
  let bytes = 0;
  let fromBacklog = 0;

  const offer = (path: string, size: number, isBacklog: boolean) => {
    if (seen.has(path)) {
      return;
    }
    seen.add(path);
    const cost = weight(size);
    if (focus.length < maxFiles && bytes + cost <= maxBytes) {
      focus.push(path);
      bytes += cost;
      fromBacklog += Number(isBacklog);
    } else {
      left.push(path);
    }
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
  let paths: unknown;
  try {
    const value = JSON.parse(text ?? 'null') as { version?: unknown; paths?: unknown } | null;
    paths = value?.version === 1 ? value.paths : null;
  } catch {
    return [];
  }
  if (!Array.isArray(paths)) {
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
