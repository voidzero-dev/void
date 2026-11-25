import { expect, it } from 'vite-plus/test';
import { buildSecurityScanInput } from '../../src/security/input/build.ts';
import type { SecurityInputPlan } from '../../src/security/input/build.ts';
import {
  claimedCommitMismatch,
  comparisonChangedPaths,
  mapBundleToRepo,
  planSecuritySourceDiff,
  SECURITY_T1_NOTES,
  securityCompareProblem,
  startSecuritySourceDiff,
} from '../../src/security/input/t1.ts';
import type { SecurityRepoIndex } from '../../src/security/input/t1.ts';
import { bundleSources, sha256Hex } from '../../src/security/input/t2.ts';
import type { SecurityModuleFile } from '../../src/security/input/t2.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const CONNECTION = { installationId: '1', repoFullName: 'acme/mono', repositoryId: '9' };

const module = (name: string, text: string): SecurityModuleFile => ({
  name,
  text,
  sha256: sha256Hex(text),
});

/** A monorepo at the head commit: the project is `apps/web`. */
const REPO: Record<string, string> = {
  'apps/web/package.json': '{"name":"web"}',
  'apps/web/.env': 'TOKEN=x',
  'apps/web/src/server.ts': 'export default { fetch }',
  'apps/web/src/routes/users.ts': 'export const GET = () => db.users()',
  'apps/web/src/client/app.tsx': 'export function App() {}',
  'packages/shared/src/auth.ts': 'export function auth() {}',
  'packages/other/src/x.ts': 'export const x = 1',
};
const repo: SecurityRepoIndex = new Map(
  Object.entries(REPO).map(([path, text]) => [
    path,
    { sha256: sha256Hex(text), size: new TextEncoder().encode(text).length },
  ]),
);
const COMPARED = comparisonChangedPaths([
  { filename: 'apps/web/src/routes/users.ts', status: 'modified' },
  { filename: 'apps/web/src/client/app.tsx', status: 'added' },
  { filename: 'packages/shared/src/auth.ts', status: 'modified' },
  { filename: 'packages/other/src/x.ts', status: 'modified' },
  { filename: 'apps/web/src/old.ts', status: 'removed' },
]);

/** The project's Worker bundle, built in `apps/web/dist`, with one installed package. */
function bundle(overrides: Record<string, string> = {}): Array<SecurityModuleFile> {
  const text = (path: string) => overrides[path] ?? REPO[path];
  const sources: Record<string, string> = {
    '../src/server.ts': text('apps/web/src/server.ts'),
    '../src/routes/users.ts': text('apps/web/src/routes/users.ts'),
    '../../../packages/shared/src/auth.ts': text('packages/shared/src/auth.ts'),
    '../../../node_modules/.pnpm/hono@4/node_modules/hono/dist/index.js': 'export class Hono {}',
  };
  const map = { version: 3, sources: Object.keys(sources), sourcesContent: Object.values(sources) };
  return [
    module('index.js', 'export default {}'),
    module('index.js.map', JSON.stringify({ ...map, mappings: '' })),
  ];
}

function mapped(modules: Array<SecurityModuleFile>) {
  const result = mapBundleToRepo(bundleSources(modules, 'index.js').files, repo, false);
  if (!result.ok) {
    throw new Error(`no mapping: ${result.note}`);
  }
  return result;
}

it('starts a source diff only with managed builds, GitHub, both commits and a trusted commit', () => {
  const ok = { managedBuilds: true, connection: CONNECTION, baseCommit: BASE, headCommit: HEAD };
  const refused = { ok: false, note: null };
  expect(startSecuritySourceDiff({ ...ok, build: null, managedBuilds: false })).toEqual(refused);
  expect(startSecuritySourceDiff({ ...ok, build: null, connection: null })).toEqual(refused);
  expect(startSecuritySourceDiff({ ...ok, build: null, headCommit: 'main' })).toEqual(refused);
  expect(
    startSecuritySourceDiff({ ...ok, build: { executor: 'container', commitSha: HEAD } }),
  ).toEqual({ ok: true, connection: CONNECTION, base: BASE, head: HEAD, managed: true });
  // A commit that is not the OIDC sha claim or the built commit (#38).
  for (const executor of ['github_actions', 'container'] as const) {
    expect(startSecuritySourceDiff({ ...ok, build: { executor, commitSha: BASE } })).toEqual({
      ok: false,
      note: SECURITY_T1_NOTES.commitMismatch,
    });
  }
});

it('falls back to T2 on a truncated compare, a force push or an unreachable base (#9)', () => {
  expect(securityCompareProblem({ status: 'ahead', truncated: false })).toBeNull();
  expect(securityCompareProblem({ status: 'ahead', truncated: true })).toBe(
    SECURITY_T1_NOTES.truncated,
  );
  expect(securityCompareProblem({ status: 'diverged', truncated: false })).toBe(
    SECURITY_T1_NOTES.notAncestor,
  );
  expect(securityCompareProblem(null)).toBe(SECURITY_T1_NOTES.unavailable);
});

it('refuses a bundle whose changed code is not the claimed commit (#38)', () => {
  const users = 'apps/web/src/routes/users.ts';
  const check = (overrides: Record<string, string>, noSourceMaps = 0) =>
    claimedCommitMismatch({
      mapping: mapped(bundle(overrides)),
      changedRepoPaths: COMPARED,
      builtChanged: new Set(),
      noSourceMaps,
    });
  expect(check({})).toBe(false);
  expect(check({ [users]: 'shipped other code' })).toBe(true);
  // An unchanged file may differ: its live text was scanned before.
  expect(check({ 'apps/web/src/server.ts': 'older text' })).toBe(false);
  expect(check({}, 1)).toBe(true);
});

it('sends the changed files as focus, drops secret-like files and backlogs an unread change', () => {
  const modules = bundle();
  const diff = planSecuritySourceDiff({
    mapping: mapped(modules),
    repo,
    managed: false,
    sources: bundleSources(modules, 'index.js').files,
    changedRepoPaths: COMPARED,
    builtChanged: new Set(['src/routes/users.ts']),
    budget: { bytes: 1024 * 1024, files: 1000 },
  });
  const files = [
    ...diff.read.map((file) => ({
      path: file.inputPath,
      text: REPO[file.repoPath],
      sha256: file.sha256,
      module: '',
      map: null,
      built: false,
    })),
    ...diff.bundleOnly,
  ];
  const plan = (changed: ReadonlySet<string>): SecurityInputPlan => ({
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
      changed,
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
  });

  const built = buildSecurityScanInput(plan(diff.changed));
  expect(built.tier).toBe('source_diff');
  // Other packages and installed packages stay out of the focus.
  expect(built.focus).toEqual([
    'src/routes/users.ts',
    'packages/shared/src/auth.ts',
    'src/client/app.tsx',
  ]);
  expect(built.notes).toContain('dropped secret-like file .env');
  expect(built.entries.map((entry) => entry.path)).not.toContain('input/.env');
  expect(built.coverage).toBe('complete');

  const capped = buildSecurityScanInput(plan(new Set([...diff.changed, 'src/big.ts'])));
  expect(capped.backlog).toEqual(['src/big.ts']);
  expect(capped.coverage).toBe('partial');
});
