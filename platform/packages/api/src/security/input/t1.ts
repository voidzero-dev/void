/**
 * T1 source diff (spec §7.1, §7.4; design doc 0095, M11). Pure functions; the
 * GitHub and R2 side is `t1-github.ts`.
 *
 *   managedBuilds + GitHub connection + base and head commit ──► start
 *     managed (container build at a known sha) ─► no content check
 *     GitHub Actions (OIDC) ─► claimed commit = the token's `sha` claim, then the check
 *     any other deploy ─► content check
 *   compare(base...head): `ahead` / `identical`, not truncated ──► else T2 (edge #9)
 *   bundle sources ─► repo paths (same text) ─► project root + shared folders
 *     not one line of folders ─► T2 + `monorepo-shared-code` (edge #32)
 *   content check: a changed server file whose text differs from the commit, no
 *   source maps, or nothing matched ─► T2 + `commit-mismatch` (edge #38)
 *   scope = project root ∪ repo files the source maps list (outside it)
 *   changed = compare files in scope ∪ server sources the built output changed
 *
 * The built-output changes are part of T1 so the code that went live is scanned
 * even when the base's claimed commit was not what it shipped.
 *
 * Input paths match T2's: a repo file the bundle lists keeps the bundle's source
 * path, any other file is relative to the project root. A finding keeps its file
 * when a project moves between T1 and T2.
 */
import { SCAN_INPUT_LIMITS } from '../../../../security-scanner/src/runner/limits.ts';
import { utf8Length } from './build.ts';
import { securityInputFilter } from './filters.ts';
import type { SecuritySourceFile } from './t2.ts';

export const SECURITY_T1_NOTES = {
  commitMismatch: 'commit-mismatch',
  monorepo: 'monorepo-shared-code',
  truncated: 'compare-truncated',
  notAncestor: 'base-not-ancestor',
  unavailable: 'source-diff-unavailable',
  tooLarge: 'source-too-large',
} as const;

export type SecurityT1Fallback = Readonly<{ ok: false; note: string | null }>;

export type SecurityGithubConnection = Readonly<{
  installationId: string;
  repoFullName: string;
  repositoryId: string;
}>;

/** The build that made the head deployment, when a platform build did. */
export type SecurityHeadBuild = Readonly<{
  executor: 'container' | 'github_actions';
  /** The commit the server fetched (container) or the OIDC token's `sha` claim. */
  commitSha: string | null;
}>;

export type SecurityT1Start =
  | Readonly<{
      ok: true;
      connection: SecurityGithubConnection;
      base: string;
      head: string;
      /** The server built the source at `head` itself: no content check. */
      managed: boolean;
    }>
  | SecurityT1Fallback;

/** A full or short hex commit id: nothing else goes into a GitHub URL. */
export function isCommitSha(value: string | null): value is string {
  if (value === null || value.length < 7 || value.length > 64) {
    return false;
  }
  for (const char of value) {
    const isHex = (char >= '0' && char <= '9') || (char >= 'a' && char <= 'f');
    if (!isHex && !(char >= 'A' && char <= 'F')) {
      return false;
    }
  }
  return true;
}

/** Whether T1 can be tried at all; `note: null` when it never applied. */
export function startSecuritySourceDiff(
  input: Readonly<{
    /** Hosted only: a standard self-hosted install has no `managedBuilds`. */
    managedBuilds: boolean;
    connection: SecurityGithubConnection | null;
    baseCommit: string | null;
    /** The head deployment's claimed commit. */
    headCommit: string | null;
    build: SecurityHeadBuild | null;
  }>,
): SecurityT1Start {
  if (!input.managedBuilds || input.connection === null) {
    return { ok: false, note: null };
  }
  if (!isCommitSha(input.baseCommit) || !isCommitSha(input.headCommit)) {
    return { ok: false, note: null };
  }
  const build = input.build;
  if (build !== null && build.commitSha !== input.headCommit) {
    // A platform build deployed a commit other than the one it built (container) or
    // the one its OIDC token names (GitHub Actions).
    return { ok: false, note: SECURITY_T1_NOTES.commitMismatch };
  }
  return {
    ok: true,
    connection: input.connection,
    base: input.baseCommit,
    head: input.headCommit,
    managed: build?.executor === 'container',
  };
}

export type SecurityCompareSummary = Readonly<{
  status: string;
  truncated: boolean;
}>;

/** Why the comparison cannot drive a source diff, or `null` when it can. */
export function securityCompareProblem(compare: SecurityCompareSummary | null): string | null {
  if (compare === null) {
    return SECURITY_T1_NOTES.unavailable;
  }
  if (compare.status !== 'ahead' && compare.status !== 'identical') {
    // `behind` / `diverged`: a force push or a rollback moved the head off the base.
    return SECURITY_T1_NOTES.notAncestor;
  }
  if (compare.truncated) {
    return SECURITY_T1_NOTES.truncated;
  }
  return null;
}

/** One file of the head tarball. */
export type SecurityRepoFile = Readonly<{ sha256: string; size: number }>;
export type SecurityRepoIndex = ReadonlyMap<string, SecurityRepoFile>;

export type SecurityRepoMapping = Readonly<{
  ok: true;
  /** The project's folder in the repository: `''` or ending in `/`. */
  root: string;
  /** Folders the bundle's sources sit under, deepest (the root) first. */
  chain: ReadonlyArray<string>;
  /** Bundle source path → its repo file, with whether the texts are the same. */
  mapped: ReadonlyMap<string, Readonly<{ repoPath: string; same: boolean }>>;
  /** Sources whose text was found in the repository. */
  verified: number;
}>;

function isAncestorFolder(folder: string, of: string): boolean {
  return folder === '' || of.startsWith(folder);
}

/**
 * Places the bundle's sources in the repository. A source path is the map's path
 * with any `..` above the output folder dropped, so it ends a repo path: the folder
 * in front of it is the source's prefix. Each source whose text is found at
 * exactly one such path votes for that prefix. The prefixes must sit on one line
 * of folders (project root, then the folders shared code sits under), else the
 * project cannot be told apart from the rest of a monorepo.
 *
 * A managed build ran at the repository root, so its root is `''`.
 */
export function mapBundleToRepo(
  sources: ReadonlyArray<SecuritySourceFile>,
  repo: SecurityRepoIndex,
  managed: boolean,
): SecurityRepoMapping | SecurityT1Fallback {
  const wanted = new Map<string, SecuritySourceFile>();
  for (const source of sources) {
    if (!source.built) {
      wanted.set(source.path, source);
    }
  }
  // Source path → repo paths that end with it.
  const candidates = new Map<string, Array<string>>();
  for (const repoPath of repo.keys()) {
    let at = 0;
    for (;;) {
      const suffix = repoPath.slice(at);
      if (wanted.has(suffix)) {
        const list = candidates.get(suffix);
        if (list) {
          list.push(repoPath);
        } else {
          candidates.set(suffix, [repoPath]);
        }
      }
      const slash = repoPath.indexOf('/', at);
      if (slash === -1) {
        break;
      }
      at = slash + 1;
    }
  }
  const prefixes = new Set<string>();
  for (const [path, list] of candidates) {
    const source = wanted.get(path)!;
    const same = list.filter((repoPath) => repo.get(repoPath)!.sha256 === source.sha256);
    if (same.length === 1) {
      prefixes.add(same[0]!.slice(0, same[0]!.length - path.length));
    }
  }
  const chain = [...prefixes].sort((left, right) => right.length - left.length);
  if (managed) {
    if (!prefixes.has('')) {
      chain.push('');
    }
  } else {
    if (chain.length === 0) {
      return { ok: false, note: SECURITY_T1_NOTES.commitMismatch };
    }
    const deepest = chain[0]!;
    if (!chain.every((folder) => isAncestorFolder(folder, deepest))) {
      return { ok: false, note: SECURITY_T1_NOTES.monorepo };
    }
  }
  const root = managed ? '' : chain[0]!;
  const mapped = new Map<string, { repoPath: string; same: boolean }>();
  let verified = 0;
  for (const [path, source] of wanted) {
    let first: string | null = null;
    let match: string | null = null;
    for (const folder of chain) {
      const repoPath = `${folder}${path}`;
      const file = repo.get(repoPath);
      if (file === undefined) {
        continue;
      }
      first ??= repoPath;
      if (file.sha256 === source.sha256) {
        match = repoPath;
        break;
      }
    }
    if (match !== null) {
      verified++;
      mapped.set(path, { repoPath: match, same: true });
    } else if (first !== null) {
      mapped.set(path, { repoPath: first, same: false });
    }
  }
  if (!managed && verified === 0) {
    return { ok: false, note: SECURITY_T1_NOTES.commitMismatch };
  }
  return { ok: true, root, chain, mapped, verified };
}

/**
 * The claimed commit check for a deploy the server did not build (spec §7.1, D36):
 * every changed server file the bundle lists must have the commit's text, and the
 * bundle must have source maps. `true` when it fails.
 */
export function claimedCommitMismatch(
  input: Readonly<{
    mapping: SecurityRepoMapping;
    /** Repo paths the comparison changed. */
    changedRepoPaths: ReadonlySet<string>;
    /** Bundle source paths the built output changed (T2's rule). */
    builtChanged: ReadonlySet<string>;
    noSourceMaps: number;
  }>,
): boolean {
  if (input.noSourceMaps > 0) {
    return true;
  }
  for (const [path, entry] of input.mapping.mapped) {
    if (
      !entry.same &&
      (input.builtChanged.has(path) || input.changedRepoPaths.has(entry.repoPath))
    ) {
      return true;
    }
  }
  return false;
}

/** Repo paths a comparison left in the head (renames by their new name). */
export function comparisonChangedPaths(
  files: ReadonlyArray<Readonly<{ filename: string; status: string }>>,
): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    if (file.status !== 'removed' && file.status !== 'unchanged') {
      out.add(file.filename);
    }
  }
  return out;
}

function hasSegment(path: string, segment: string): boolean {
  return path === segment || path.startsWith(`${segment}/`) || path.includes(`/${segment}/`);
}

const CONFIG_NAMES = ['void.config.', 'wrangler.', 'vite.config.', 'package.json', 'tsconfig'];

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Priority of a repo file that is not server code (spec §7.4, T1 order): config,
 * then other code (client code), then tests and docs.
 */
export function securityRepoRank(path: string): number {
  const name = baseName(path).toLowerCase();
  if (CONFIG_NAMES.some((start) => name.startsWith(start))) {
    return 1;
  }
  const lower = path.toLowerCase();
  if (
    hasSegment(lower, 'test') ||
    hasSegment(lower, 'tests') ||
    hasSegment(lower, '__tests__') ||
    hasSegment(lower, 'docs') ||
    name.includes('.test.') ||
    name.includes('.spec.') ||
    name.endsWith('.md') ||
    name.endsWith('.mdx')
  ) {
    return 3;
  }
  return 2;
}

export type SecurityRepoRead = Readonly<{
  repoPath: string;
  inputPath: string;
  sha256: string;
  size: number;
}>;

export type SecuritySourceDiffPlan = Readonly<{
  /** Repo files to read, in priority order. */
  read: ReadonlyArray<SecurityRepoRead>;
  /** In-scope files left unread (the read limits), in priority order. */
  unread: ReadonlyArray<Readonly<{ path: string; bytes: number; sha256: string }>>;
  /** Secret-like files in scope: never read, listed in the coverage notes. */
  secret: ReadonlyArray<Readonly<{ path: string; bytes: number }>>;
  /** Bundle sources with no repo file (generated code, packages), under their own path. */
  bundleOnly: ReadonlyArray<SecuritySourceFile>;
  /** Input paths that changed since the base. */
  changed: ReadonlySet<string>;
}>;

/**
 * What a source diff reads: the project root and the repo files the bundle lists
 * outside it, server code first (bundle order), then config, other code, tests and
 * docs; changed files before the rest. `budget` is what repo files and bundle-only
 * sources may hold together, next to assets and memory: changed repo files may use
 * all of it, unchanged ones only what the bundle-only sources leave.
 */
export function planSecuritySourceDiff(
  input: Readonly<{
    mapping: SecurityRepoMapping;
    repo: SecurityRepoIndex;
    /** The server built the head itself: a source whose text differs still reads the repo. */
    managed: boolean;
    /** The bundle's sources, in import-graph order. */
    sources: ReadonlyArray<SecuritySourceFile>;
    changedRepoPaths: ReadonlySet<string>;
    builtChanged: ReadonlySet<string>;
    budget: Readonly<{ bytes: number; files: number }>;
  }>,
): SecuritySourceDiffPlan {
  const { mapping, repo } = input;
  const taken = new Set<string>();
  const place = (path: string): string => {
    let placed = path;
    for (let suffix = 2; taken.has(placed); suffix++) {
      placed = `${path}~${suffix}`;
    }
    taken.add(placed);
    return placed;
  };

  type Entry = { repoPath: string; inputPath: string; rank: number; order: number };
  const entries: Array<Entry> = [];
  const byRepoPath = new Map<string, Entry>();
  const secret: Array<{ path: string; bytes: number }> = [];
  const bundleOnly: Array<SecuritySourceFile> = [];
  const changed = new Set<string>();
  /** Repo files whose bundle text differs on a deploy the server did not build. */
  const shadowed = new Set<string>();
  const fromRepo = (path: string): boolean => {
    const entry = mapping.mapped.get(path);
    return entry !== undefined && (entry.same || input.managed);
  };
  let order = 0;

  // Server code: the bundle's sources in import-graph order, at their repo file.
  for (const source of input.sources) {
    const entry = source.built ? undefined : mapping.mapped.get(source.path);
    if (entry === undefined) {
      continue;
    }
    if (!fromRepo(source.path)) {
      // The live text is the bundle's (unchanged since the base, or the check failed).
      shadowed.add(entry.repoPath);
      continue;
    }
    if (byRepoPath.has(entry.repoPath)) {
      continue;
    }
    const filter = securityInputFilter(entry.repoPath);
    if (filter !== null) {
      // A secret-like file the bundle lists is noted with the rest below.
      continue;
    }
    const placed: Entry = {
      repoPath: entry.repoPath,
      inputPath: place(source.path),
      rank: 0,
      order: order++,
    };
    entries.push(placed);
    byRepoPath.set(entry.repoPath, placed);
    if (input.builtChanged.has(source.path)) {
      changed.add(placed.inputPath);
    }
  }
  const mappedRepoPaths = new Set([...mapping.mapped.values()].map((entry) => entry.repoPath));
  for (const repoPath of shadowed) {
    if (byRepoPath.has(repoPath)) {
      shadowed.delete(repoPath);
    }
  }
  // The rest of the project root, in path order.
  const rest = [...repo.keys()]
    .filter((repoPath) => {
      if (byRepoPath.has(repoPath) || shadowed.has(repoPath)) {
        return false;
      }
      if (mappedRepoPaths.has(repoPath)) {
        return true;
      }
      if (!repoPath.startsWith(mapping.root)) {
        return false;
      }
      // Installed packages are not the project's code; the bundle lists the ones it uses.
      return !hasSegment(repoPath.slice(mapping.root.length), 'node_modules');
    })
    .sort();
  for (const repoPath of rest) {
    const filter = securityInputFilter(repoPath);
    const inputPath = repoPath.startsWith(mapping.root)
      ? repoPath.slice(mapping.root.length)
      : repoPath;
    if (filter === 'secret') {
      secret.push({ path: inputPath, bytes: repo.get(repoPath)!.size });
      continue;
    }
    if (filter === 'skipped') {
      continue;
    }
    const placed: Entry = {
      repoPath,
      inputPath: place(inputPath),
      rank: securityRepoRank(inputPath),
      order: order++,
    };
    entries.push(placed);
    byRepoPath.set(repoPath, placed);
  }
  for (const repoPath of input.changedRepoPaths) {
    const entry = byRepoPath.get(repoPath);
    if (entry !== undefined) {
      changed.add(entry.inputPath);
    }
  }
  // Bundle sources with no repo file: read from the bundle, ranked last.
  for (const source of input.sources) {
    if (!source.built && fromRepo(source.path)) {
      continue;
    }
    const inputPath = place(source.path);
    bundleOnly.push(inputPath === source.path ? source : { ...source, path: inputPath });
    if (input.builtChanged.has(source.path)) {
      changed.add(inputPath);
    }
  }

  const ordered = entries.sort((left, right) => {
    const leftChanged = changed.has(left.inputPath) ? 0 : 1;
    const rightChanged = changed.has(right.inputPath) ? 0 : 1;
    return leftChanged - rightChanged || left.rank - right.rank || left.order - right.order;
  });
  const read: Array<SecurityRepoRead> = [];
  const unread: Array<{ path: string; bytes: number; sha256: string }> = [];
  let reservedBytes = 0;
  for (const source of bundleOnly) {
    reservedBytes += utf8Length(source.text);
  }
  let bytes = 0;
  let files = 0;
  for (const entry of ordered) {
    const file = repo.get(entry.repoPath)!;
    const first = changed.has(entry.inputPath);
    const maxBytes = first ? input.budget.bytes : input.budget.bytes - reservedBytes;
    const maxFiles = first ? input.budget.files : input.budget.files - bundleOnly.length;
    if (
      files >= maxFiles ||
      bytes + file.size > maxBytes ||
      file.size > SCAN_INPUT_LIMITS.maxFileBytes
    ) {
      unread.push({ path: entry.inputPath, bytes: file.size, sha256: file.sha256 });
      continue;
    }
    bytes += file.size;
    files++;
    read.push({
      repoPath: entry.repoPath,
      inputPath: entry.inputPath,
      sha256: file.sha256,
      size: file.size,
    });
  }
  return { read, unread, secret, bundleOnly, changed };
}
