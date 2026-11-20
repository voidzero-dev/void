import { describe, expect, it } from 'vite-plus/test';
import { buildSecurityScanInput, type SecurityInputPlan } from '../../src/security/input/build.ts';
import {
  SourceTarballError,
  sourceTarballPath,
  SourceTarballTooLarge,
  walkSourceTarball,
} from '../../src/security/input/source-tar.ts';
import {
  claimedCommitMismatch,
  comparisonChangedPaths,
  isCommitSha,
  mapBundleToRepo,
  planSecuritySourceDiff,
  SECURITY_T1_NOTES,
  securityCompareProblem,
  securityRepoRank,
  startSecuritySourceDiff,
  type SecurityRepoIndex,
  type SecurityRepoMapping,
} from '../../src/security/input/t1.ts';
import { bundleSources, sha256Hex, type SecurityModuleFile } from '../../src/security/input/t2.ts';
import { tarChunks } from '../../src/security/input/tar.ts';
import { chooseSecurityTier, securityCoverageLabel } from '../../src/security/input/tier.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const CONNECTION = { installationId: '1', repoFullName: 'acme/mono', repositoryId: '9' };

function module(name: string, text: string): SecurityModuleFile {
  return { name, text, sha256: sha256Hex(text) };
}

function map(sources: Record<string, string>): string {
  return JSON.stringify({
    version: 3,
    sources: Object.keys(sources),
    sourcesContent: Object.values(sources),
    mappings: '',
  });
}

/** A monorepo at the head commit: the project is `apps/web`. */
const REPO: Record<string, string> = {
  'package.json': '{"private":true}',
  'pnpm-lock.yaml': 'lockfileVersion: 9',
  'apps/web/package.json': '{"name":"web"}',
  'apps/web/void.config.ts': 'export default {}',
  'apps/web/.env': 'TOKEN=x',
  'apps/web/README.md': '# web',
  'apps/web/src/server.ts': 'export default { fetch }',
  'apps/web/src/routes/users.ts': 'export const GET = () => db.users()',
  'apps/web/src/client/app.tsx': 'export function App() {}',
  'apps/web/test/users.test.ts': 'test("users", () => {})',
  'apps/web/node_modules/hono/index.js': 'export const Hono = 1',
  'apps/admin/src/server.ts': 'export default { admin: true }',
  'packages/shared/src/auth.ts': 'export function auth() {}',
  'packages/other/src/x.ts': 'export const x = 1',
};

function repoIndex(files: Record<string, string>): SecurityRepoIndex {
  return new Map(
    Object.entries(files).map(([path, text]) => [
      path,
      { sha256: sha256Hex(text), size: new TextEncoder().encode(text).length },
    ]),
  );
}

/**
 * The project's Worker bundle, built in `apps/web/dist`: its own sources one folder
 * up, the shared package three, an installed package from the pnpm store.
 */
function bundle(overrides: Record<string, string> = {}): Array<SecurityModuleFile> {
  const text = (path: string) => overrides[path] ?? REPO[path]!;
  return [
    module('index.js', 'import"./chunk.js";export default {}'),
    module(
      'index.js.map',
      map({
        '../src/server.ts': text('apps/web/src/server.ts'),
        '../src/routes/users.ts': text('apps/web/src/routes/users.ts'),
        '../../../packages/shared/src/auth.ts': text('packages/shared/src/auth.ts'),
        '../../../node_modules/.pnpm/hono@4/node_modules/hono/dist/index.js':
          'export class Hono {}',
      }),
    ),
  ];
}

const COMPARE_FILES = [
  { filename: 'apps/web/src/routes/users.ts', status: 'modified' },
  { filename: 'apps/web/src/client/app.tsx', status: 'added' },
  { filename: 'apps/admin/src/server.ts', status: 'modified' },
  { filename: 'packages/shared/src/auth.ts', status: 'modified' },
  { filename: 'packages/other/src/x.ts', status: 'modified' },
  { filename: 'apps/web/src/old.ts', status: 'removed' },
  { filename: 'pnpm-lock.yaml', status: 'modified' },
];

function mapped(
  modules: Array<SecurityModuleFile>,
  repo: SecurityRepoIndex,
  managed = false,
): SecurityRepoMapping {
  const result = mapBundleToRepo(bundleSources(modules, 'index.js').files, repo, managed);
  if (!result.ok) {
    throw new Error(`no mapping: ${result.note}`);
  }
  return result;
}

describe('startSecuritySourceDiff', () => {
  const ok = {
    managedBuilds: true,
    connection: CONNECTION,
    baseCommit: BASE,
    headCommit: HEAD,
    build: null,
  };

  it('never applies without managedBuilds: self-hosted takes T2 (exit check)', () => {
    expect(startSecuritySourceDiff({ ...ok, managedBuilds: false })).toEqual({
      ok: false,
      note: null,
    });
  });

  it('needs a GitHub connection and both commits', () => {
    expect(startSecuritySourceDiff({ ...ok, connection: null })).toEqual({ ok: false, note: null });
    expect(startSecuritySourceDiff({ ...ok, baseCommit: null })).toEqual({ ok: false, note: null });
    // A dirty tree, --skip-build or no git sends no commit; the builder notes `no-commit`.
    expect(startSecuritySourceDiff({ ...ok, headCommit: null })).toEqual({ ok: false, note: null });
    expect(startSecuritySourceDiff({ ...ok, headCommit: 'main' })).toEqual({
      ok: false,
      note: null,
    });
  });

  it('trusts a container build at the commit the server fetched', () => {
    expect(
      startSecuritySourceDiff({ ...ok, build: { executor: 'container', commitSha: HEAD } }),
    ).toEqual({ ok: true, connection: CONNECTION, base: BASE, head: HEAD, managed: true });
  });

  it('checks a CLI deploy and a GitHub Actions deploy against their content', () => {
    expect(startSecuritySourceDiff(ok)).toMatchObject({ ok: true, managed: false });
    expect(
      startSecuritySourceDiff({ ...ok, build: { executor: 'github_actions', commitSha: HEAD } }),
    ).toMatchObject({ ok: true, managed: false });
  });

  it('refuses a commit that is not the OIDC sha claim or the built commit (#38)', () => {
    for (const executor of ['github_actions', 'container'] as const) {
      expect(startSecuritySourceDiff({ ...ok, build: { executor, commitSha: BASE } })).toEqual({
        ok: false,
        note: SECURITY_T1_NOTES.commitMismatch,
      });
    }
  });

  it('reads commit ids as hex only', () => {
    expect(isCommitSha('abc1234')).toBe(true);
    expect(isCommitSha('ABC1234def')).toBe(true);
    expect(isCommitSha('abc')).toBe(false);
    expect(isCommitSha('abc123../x')).toBe(false);
    expect(isCommitSha(null)).toBe(false);
  });
});

describe('securityCompareProblem', () => {
  it('takes a head that moved forward from the base', () => {
    expect(securityCompareProblem({ status: 'ahead', truncated: false })).toBeNull();
    expect(securityCompareProblem({ status: 'identical', truncated: false })).toBeNull();
  });

  it('falls back to T2 on a truncated compare (#9)', () => {
    expect(securityCompareProblem({ status: 'ahead', truncated: true })).toBe(
      SECURITY_T1_NOTES.truncated,
    );
  });

  it('falls back to T2 after a force push or an unreachable base (#9)', () => {
    expect(securityCompareProblem({ status: 'diverged', truncated: false })).toBe(
      SECURITY_T1_NOTES.notAncestor,
    );
    expect(securityCompareProblem({ status: 'behind', truncated: false })).toBe(
      SECURITY_T1_NOTES.notAncestor,
    );
    // A base commit GitHub no longer has: the compare cannot be read.
    expect(securityCompareProblem(null)).toBe(SECURITY_T1_NOTES.unavailable);
  });

  it('is never reached without a base snapshot: that is T3 (#9)', () => {
    expect(
      chooseSecurityTier({
        trigger: 'deploy',
        baseDeploymentId: 'dpl_base',
        baseSnapshot: false,
        sourceDiff: true,
      }),
    ).toEqual({ tier: 'full', fullReason: 'no_usable_base' });
  });

  it('lists the files a comparison leaves in the head', () => {
    expect([...comparisonChangedPaths(COMPARE_FILES)].sort()).toEqual([
      'apps/admin/src/server.ts',
      'apps/web/src/client/app.tsx',
      'apps/web/src/routes/users.ts',
      'packages/other/src/x.ts',
      'packages/shared/src/auth.ts',
      'pnpm-lock.yaml',
    ]);
  });
});

describe('mapBundleToRepo', () => {
  it('finds the project root and the shared package of a monorepo (#32)', () => {
    const mapping = mapped(bundle(), repoIndex(REPO));
    expect(mapping.root).toBe('apps/web/');
    expect(mapping.chain).toEqual(['apps/web/', '']);
    expect(Object.fromEntries(mapping.mapped)).toEqual({
      'src/server.ts': { repoPath: 'apps/web/src/server.ts', same: true },
      'src/routes/users.ts': { repoPath: 'apps/web/src/routes/users.ts', same: true },
      'packages/shared/src/auth.ts': { repoPath: 'packages/shared/src/auth.ts', same: true },
    });
    expect(mapping.verified).toBe(3);
  });

  it('falls back with monorepo-shared-code when the folders are not one line (#32)', () => {
    const repo = repoIndex({
      'apps/web/src/a.ts': 'export const a = 1',
      'apps/admin/src/b.ts': 'export const b = 2',
    });
    const modules = [
      module('index.js', 'export default {}'),
      module(
        'index.js.map',
        map({ '../src/a.ts': 'export const a = 1', '../src/b.ts': 'export const b = 2' }),
      ),
    ];
    expect(mapBundleToRepo(bundleSources(modules, 'index.js').files, repo, false)).toEqual({
      ok: false,
      note: SECURITY_T1_NOTES.monorepo,
    });
  });

  it('finds nothing to check when no source has the commit text (#38)', () => {
    const modules = bundle({
      'apps/web/src/server.ts': 'evil()',
      'apps/web/src/routes/users.ts': 'evil()',
      'packages/shared/src/auth.ts': 'evil()',
    });
    expect(
      mapBundleToRepo(bundleSources(modules, 'index.js').files, repoIndex(REPO), false),
    ).toEqual({ ok: false, note: SECURITY_T1_NOTES.commitMismatch });
  });

  it('puts a managed build at the repository root', () => {
    const repo = repoIndex({ 'src/server.ts': 'export default {}' });
    const modules = [
      module('index.js', 'export default {}'),
      module('index.js.map', map({ '../src/server.ts': 'changed by the build' })),
    ];
    const mapping = mapped(modules, repo, true);
    expect(mapping.root).toBe('');
    expect(mapping.mapped.get('src/server.ts')).toEqual({
      repoPath: 'src/server.ts',
      same: false,
    });
  });
});

describe('claimedCommitMismatch', () => {
  const repo = repoIndex(REPO);
  const changedRepoPaths = comparisonChangedPaths(COMPARE_FILES);

  it('passes a bundle that holds the commit text', () => {
    expect(
      claimedCommitMismatch({
        mapping: mapped(bundle(), repo),
        changedRepoPaths,
        builtChanged: new Set(['src/routes/users.ts']),
        noSourceMaps: 0,
      }),
    ).toBe(false);
  });

  it('fails when a changed server file differs from the commit (#38)', () => {
    const mapping = mapped(bundle({ 'apps/web/src/routes/users.ts': 'shipped other code' }), repo);
    // Changed in the comparison …
    expect(
      claimedCommitMismatch({
        mapping,
        changedRepoPaths,
        builtChanged: new Set(),
        noSourceMaps: 0,
      }),
    ).toBe(true);
    // … or in the built output.
    expect(
      claimedCommitMismatch({
        mapping,
        changedRepoPaths: new Set(),
        builtChanged: new Set(['src/routes/users.ts']),
        noSourceMaps: 0,
      }),
    ).toBe(true);
  });

  it('lets an unchanged file differ: its live text was scanned before', () => {
    const mapping = mapped(bundle({ 'apps/web/src/server.ts': 'older text' }), repo);
    expect(
      claimedCommitMismatch({
        mapping,
        changedRepoPaths,
        builtChanged: new Set(),
        noSourceMaps: 0,
      }),
    ).toBe(false);
  });

  it('fails without source maps (#38)', () => {
    expect(
      claimedCommitMismatch({
        mapping: mapped(bundle(), repo),
        changedRepoPaths,
        builtChanged: new Set(),
        noSourceMaps: 1,
      }),
    ).toBe(true);
  });
});

describe('planSecuritySourceDiff', () => {
  const repo = repoIndex(REPO);
  const budget = { bytes: 1024 * 1024, files: 1000 };

  function plan(
    modules: Array<SecurityModuleFile>,
    options: { builtChanged?: Set<string>; budget?: { bytes: number; files: number } } = {},
  ) {
    return planSecuritySourceDiff({
      mapping: mapped(modules, repo),
      repo,
      managed: false,
      sources: bundleSources(modules, 'index.js').files,
      changedRepoPaths: comparisonChangedPaths(COMPARE_FILES),
      builtChanged: options.builtChanged ?? new Set(['src/routes/users.ts']),
      budget: options.budget ?? budget,
    });
  }

  it('reads the project root plus the shared files the source maps list (#32)', () => {
    const result = plan(bundle());
    expect(result.read.map((file) => [file.inputPath, file.repoPath])).toEqual([
      // Changed first: server code in bundle order, then client code.
      ['src/routes/users.ts', 'apps/web/src/routes/users.ts'],
      ['packages/shared/src/auth.ts', 'packages/shared/src/auth.ts'],
      ['src/client/app.tsx', 'apps/web/src/client/app.tsx'],
      // Then server code, config, other code, tests and docs.
      ['src/server.ts', 'apps/web/src/server.ts'],
      ['package.json', 'apps/web/package.json'],
      ['void.config.ts', 'apps/web/void.config.ts'],
      ['README.md', 'apps/web/README.md'],
      ['test/users.test.ts', 'apps/web/test/users.test.ts'],
    ]);
    // Other apps, unlisted packages and installed packages stay out.
    expect([...result.changed].sort()).toEqual([
      'packages/shared/src/auth.ts',
      'src/client/app.tsx',
      'src/routes/users.ts',
    ]);
    expect(result.secret).toEqual([{ path: '.env', bytes: 7 }]);
    expect(result.bundleOnly.map((file) => file.path)).toEqual([
      'node_modules/.pnpm/hono@4/node_modules/hono/dist/index.js',
    ]);
    expect(result.unread).toEqual([]);
  });

  it('keeps the live text of a file that differs from the commit', () => {
    const result = plan(bundle({ 'apps/web/src/server.ts': 'older text' }), {
      builtChanged: new Set(),
    });
    expect(result.read.map((file) => file.inputPath)).not.toContain('src/server.ts');
    const live = result.bundleOnly.find((file) => file.path === 'src/server.ts');
    expect(live?.text).toBe('older text');
  });

  it('adds a file the built output changed even when the comparison does not list it', () => {
    const result = plan(bundle(), { builtChanged: new Set(['src/server.ts']) });
    expect(result.changed.has('src/server.ts')).toBe(true);
  });

  it('leaves unchanged files unread first when the budget runs out', () => {
    const result = plan(bundle(), { budget: { bytes: 90, files: 1000 } });
    const read = result.read.map((file) => file.inputPath);
    expect(read).toEqual([
      'src/routes/users.ts',
      'packages/shared/src/auth.ts',
      'src/client/app.tsx',
    ]);
    expect(result.unread.map((file) => file.path)).toContain('src/server.ts');
  });

  it('ranks config, other code, then tests and docs', () => {
    expect(securityRepoRank('void.config.ts')).toBe(1);
    expect(securityRepoRank('wrangler.jsonc')).toBe(1);
    expect(securityRepoRank('src/client/app.tsx')).toBe(2);
    expect(securityRepoRank('src/users.test.ts')).toBe(3);
    expect(securityRepoRank('docs/guide.md')).toBe(3);
  });
});

describe('buildSecurityScanInput with a source diff', () => {
  function inputPlan(): SecurityInputPlan {
    const modules = bundle();
    const repo = repoIndex(REPO);
    const sources = bundleSources(modules, 'index.js').files;
    const diff = planSecuritySourceDiff({
      mapping: mapped(modules, repo),
      repo,
      managed: false,
      sources,
      changedRepoPaths: comparisonChangedPaths(COMPARE_FILES),
      builtChanged: new Set(['src/routes/users.ts']),
      budget: { bytes: 1024 * 1024, files: 1000 },
    });
    const files = [
      ...diff.read.map((file) => ({
        path: file.inputPath,
        text: REPO[file.repoPath]!,
        sha256: file.sha256,
        module: '',
        map: null,
        built: false,
      })),
      ...diff.bundleOnly,
    ];
    return {
      scan: {
        id: 'scan_1',
        attempt: 1,
        engine: 'void_loop',
        model: '@cf/test/model',
        trigger: 'deploy',
        commit: HEAD,
      },
      tier: { tier: 'source_diff', fullReason: null },
      sourceDiff: {
        files,
        changed: diff.changed,
        unread: [{ path: 'src/big.ts', bytes: 100, sha256: 'x' }],
        secret: diff.secret,
        notes: [],
      },
      head: { modules, main: 'index.js' },
      base: { modules: new Map(), sources: null },
      assets: [],
      backlog: [],
      recheckFiles: [],
      secrets: [],
      lockfile: null,
      memory: { findings: [], events: [], lastSucceededAt: null, ledgerSummary: null },
    };
  }

  it('sends the changed files as focus and labels the scan a source diff', () => {
    const built = buildSecurityScanInput(inputPlan());
    expect(built.tier).toBe('source_diff');
    expect(built.focus).toEqual([
      'src/routes/users.ts',
      'packages/shared/src/auth.ts',
      'src/client/app.tsx',
    ]);
    expect(built.task).toMatchObject({ tier: 'source_diff', changed_files: built.focus });
    // An unread file that did not change is read access only: dropped, never a cap.
    expect(built.notes).toEqual([
      'third-party-unverified 1 files',
      'dropped secret-like file .env',
    ]);
    expect(built.coverage).toBe('complete');
    expect(built.droppedFiles).toBe(2);
    expect(built.droppedBytes).toBe(100 + new TextEncoder().encode(REPO['apps/web/.env']!).length);
    expect(built.entries.map((entry) => entry.path)).toContain('input/src/client/app.tsx');
    expect(built.entries.map((entry) => entry.path)).not.toContain('input/.env');
    expect(
      securityCoverageLabel({
        tier: built.tier,
        coverage: built.coverage,
        coverageNotes: built.notes,
        filesScanned: built.filesScanned,
        backlogFiles: 0,
      }),
    ).toBe('source diff · 3 files');
    // An unread, unchanged file stays seen: the next scan does not count it as changed.
    expect(built.sourceIndex.get('src/big.ts')).toBe('x');
  });

  it('puts an unread changed file in the backlog', () => {
    const plan = inputPlan();
    const built = buildSecurityScanInput({
      ...plan,
      sourceDiff: {
        ...plan.sourceDiff!,
        changed: new Set([...plan.sourceDiff!.changed, 'src/big.ts']),
      },
    });
    expect(built.backlog).toEqual(['src/big.ts']);
    expect(built.sourceIndex.has('src/big.ts')).toBe(false);
    expect(built.coverage).toBe('partial');
    expect(built.notes).toContain('input-capped 1 files');
  });

  it('keeps an unread unchanged file in the backlog it was waiting in', () => {
    const built = buildSecurityScanInput({ ...inputPlan(), backlog: ['src/big.ts'] });
    expect(built.backlog).toEqual(['src/big.ts']);
    expect(built.coverage).toBe('partial');
    expect(built.notes).toContain('input-capped 1 files');
  });

  it('caps an unread unchanged file when a gate scan turns into a full scan', () => {
    const plan = inputPlan();
    const built = buildSecurityScanInput({
      ...plan,
      scan: { ...plan.scan, trigger: 'gate' },
      sourceDiff: { ...plan.sourceDiff!, changed: new Set() },
    });
    expect(built.tier).toBe('full');
    expect(built.backlog).toEqual(['src/big.ts']);
    expect(built.coverage).toBe('partial');
  });

  it('reads the bundle sources it is given instead of parsing the bundle again', () => {
    const plan: SecurityInputPlan = {
      ...inputPlan(),
      tier: { tier: 'full', fullReason: 'first_scan' },
      sourceDiff: null,
      base: null,
    };
    const paths = (built: ReturnType<typeof buildSecurityScanInput>) =>
      built.entries.map((entry) => entry.path);
    const parsed = buildSecurityScanInput(plan);
    const given = buildSecurityScanInput({
      ...plan,
      head: { modules: [], main: null },
      bundle: bundleSources(plan.head.modules, plan.head.main),
    });
    expect(paths(given)).toEqual(paths(parsed));
    expect(paths(given)).toContain('input/src/server.ts');
  });

  it('refuses a source diff with no files', () => {
    expect(() => buildSecurityScanInput({ ...inputPlan(), sourceDiff: null })).toThrow(
      'a source diff scan needs its source files',
    );
  });
});

const BLOCK = 512;

/** A raw ustar header, for names and types the API's own writer never makes. */
function rawEntry(
  name: string,
  data: string,
  type: string,
  /** The size the header claims; the body's by default. */
  size?: number,
): Array<Uint8Array> {
  const body = new TextEncoder().encode(data);
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, text: string) => block.set(new TextEncoder().encode(text), offset);
  put(0, name);
  put(100, '0000444\0');
  put(108, '0000000\0');
  put(116, '0000000\0');
  put(124, `${(size ?? body.length).toString(8).padStart(11, '0')}\0`);
  put(136, '00000000000\0');
  block.fill(0x20, 148, 156);
  put(156, type);
  put(257, 'ustar\0');
  put(263, '00');
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK);
  padded.set(body);
  return [block, padded];
}

function gzip(chunks: Array<Uint8Array>): ReadableStream<Uint8Array> {
  return new Blob(chunks as Array<BlobPart>)
    .stream()
    .pipeThrough(new CompressionStream('gzip')) as ReadableStream<Uint8Array>;
}

async function walk(
  stream: ReadableStream<Uint8Array>,
  limits = { maxFiles: 100, maxBytes: 1024 * 1024 },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await walkSourceTarball(stream, limits, (entry) => {
    let text = '';
    const decoder = new TextDecoder();
    return (chunk) => {
      if (chunk === null) {
        out.set(entry.path, text + decoder.decode());
      } else {
        text += decoder.decode(chunk, { stream: true });
      }
    };
  });
  return out;
}

describe('walkSourceTarball', () => {
  it('reads a GitHub archive with the top folder cut off, long names too', async () => {
    const long = `acme-mono-${'b'.repeat(7)}/apps/web/src/${'deep/'.repeat(30)}é.ts`;
    const chunks = [
      ...rawEntry(
        'pax_global_header',
        '52 comment=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
        'g',
      ),
      ...tarChunks([
        { path: 'acme-mono-bbbbbbb/package.json', data: '{}' },
        { path: long, data: 'export const deep = 1' },
      ]),
    ];
    const files = await walk(gzip(chunks));
    expect(Object.fromEntries(files)).toEqual({
      'package.json': '{}',
      [long.slice(long.indexOf('/') + 1)]: 'export const deep = 1',
    });
  });

  it('skips links and unsafe names', async () => {
    const chunks = [
      ...rawEntry('top/../../etc/passwd', 'root', '0'),
      ...rawEntry('top/link.ts', '', '2'),
      ...rawEntry('top/src/', '', '5'),
      ...rawEntry('top/src/ok.ts', 'ok', '0'),
      new Uint8Array(BLOCK * 2),
    ];
    expect(Object.fromEntries(await walk(gzip(chunks)))).toEqual({ 'src/ok.ts': 'ok' });
  });

  it('stops past its limits', async () => {
    const chunks = tarChunks([
      { path: 'top/a.ts', data: 'a'.repeat(600) },
      { path: 'top/b.ts', data: 'b'.repeat(600) },
    ]);
    await expect(walk(gzip(chunks), { maxFiles: 100, maxBytes: 1000 })).rejects.toBeInstanceOf(
      SourceTarballTooLarge,
    );
    await expect(walk(gzip(chunks), { maxFiles: 1, maxBytes: 10_000 })).rejects.toBeInstanceOf(
      SourceTarballTooLarge,
    );
  });

  it('counts files it skips: an unsafe name does not get past the limits', async () => {
    const control = [
      ...rawEntry('top/a\u0001.bin', 'a'.repeat(600), '0'),
      ...rawEntry('top/b\u0001.bin', 'b'.repeat(600), '0'),
      new Uint8Array(BLOCK * 2),
    ];
    await expect(walk(gzip(control), { maxFiles: 100, maxBytes: 1000 })).rejects.toBeInstanceOf(
      SourceTarballTooLarge,
    );
    await expect(walk(gzip(control), { maxFiles: 1, maxBytes: 10_000 })).rejects.toBeInstanceOf(
      SourceTarballTooLarge,
    );
  });

  it('stops at the header of a file over the byte limit, before unpacking it', async () => {
    const huge = [...rawEntry('top/huge.bin', '', '0', 600 * 1024 * 1024)];
    await expect(walk(gzip(huge))).rejects.toBeInstanceOf(SourceTarballTooLarge);
  });

  it('turns a broken gzip stream into an archive error', async () => {
    const garbage = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]).stream();
    await expect(walk(garbage as ReadableStream<Uint8Array>)).rejects.toBeInstanceOf(
      SourceTarballError,
    );
  });

  it('maps archive names to repo paths', () => {
    expect(sourceTarballPath('top/src/a.ts')).toBe('src/a.ts');
    expect(sourceTarballPath('top/')).toBeNull();
    expect(sourceTarballPath('/etc/passwd')).toBeNull();
    expect(sourceTarballPath('top/a/./b')).toBeNull();
  });
});
