import { readFileSync, statSync } from 'node:fs';
import { toSlash } from 'pathslash';

type SourceEntry = { signature: string; derived: Map<string, unknown> };

/**
 * How long after a file changes its stat is trusted to identify its contents.
 * Some file systems keep coarse timestamps (FAT: 2 s, HFS+: 1 s, ext4: one
 * kernel tick) and Linux reuses inodes, so a second write inside that window
 * can leave the signature unchanged. Like Git's racily clean index entries,
 * values derived from recently changed files are recomputed on the next read.
 */
const RACY_WINDOW_MS = 3000;

const entries = new Map<string, SourceEntry>();

/**
 * Derive a value from a source file, reusing it while the file is unchanged.
 * A dev server rescans every source file on each file event, and several
 * plugins scan the same pages, but only edited files need to be read and
 * parsed again. `kind` separates analyses of the same file. `derive` must be a
 * pure function of the source, and callers must not mutate its result.
 */
export function deriveFromSource<T>(path: string, kind: string, derive: (source: string) => T): T {
  const key = toSlash(path);
  const stat = statSync(key, { bigint: true, throwIfNoEntry: false });

  if (!stat) {
    // Keep the read error callers already handle.
    return derive(readFileSync(key, 'utf-8'));
  }

  const signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const changedAt = Number(
    (stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs) / 1_000_000n,
  );
  const trusted = Date.now() - changedAt > RACY_WINDOW_MS;
  const entry = entries.get(key);

  if (trusted && entry?.signature === signature && entry.derived.has(kind)) {
    return entry.derived.get(kind) as T;
  }

  const value = derive(readFileSync(key, 'utf-8'));

  if (!trusted) {
    entries.delete(key);
  } else if (entry?.signature === signature) {
    entry.derived.set(kind, value);
  } else {
    entries.set(key, { signature, derived: new Map([[kind, value]]) });
  }

  return value;
}

/** Forget values derived from a file. Dev servers call this for watcher events. */
export function invalidateSourceAnalysis(path: string): void {
  entries.delete(toSlash(path));
}
