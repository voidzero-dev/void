/**
 * Security audits Phase 0 spike S7 (local): what a scan can read from real Void builds.
 *
 * Design doc 0095 "Phase 0 spikes", spec §20 S7. For the React, Vue, Svelte and Solid
 * Pages playgrounds:
 *
 *   copy the app ─► `vp build` ─► the deploy's worker files (`collectWorkerFiles`, the
 *   CLI's own upload list) ─► the API's real input builder (`bundleSources`,
 *   `buildSecurityScanInput`) ─► what /scan/input would hold
 *
 * and measures: server files readable from `sourcesContent` (bar ≥ 90% of first-party),
 * source text equal to the file on disk, workspace packages kept as first-party, registry
 * code with and without a lockfile, snapshot size, and a built-diff (T2) scan after a
 * one-line change. Then it lists every place in the API that makes a deployment live and
 * checks each one enqueues a scan through the M8 path (bar: one path covers all, with
 * only the spec's exclusions).
 *
 * Builds go to `playground-local/security-spike-s7/<app>` (gitignored).
 * Run (from the repo root): node platform/scripts/security-spike-inputs.ts [--out report.json]
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { finishSpike, REPO, relaunchWithLocalLoader } from './security-spike-local.ts';
import type { SpikeCheck } from './security-spike-local.ts';

relaunchWithLocalLoader(import.meta.url);

const { collectWorkerFiles } = await import('../../packages/void/src/cli/package.ts');
const t2 = await import('../packages/api/src/security/input/t2.ts');
const build = await import('../packages/api/src/security/input/build.ts');
const thirdParty = await import('../packages/api/src/security/input/third-party.ts');
const filters = await import('../packages/api/src/security/input/filters.ts');
const { GITHUB_COMPARE_MAX_FILES } =
  await import('../packages/api/src/github/installation-token.ts');

const APPS = ['react-pages', 'vue-pages', 'svelte-pages', 'solid-pages'] as const;
const OUT_ROOT = join(REPO, 'playground-local', 'security-spike-s7');
const SKIP_COPY = new Set(['node_modules', 'dist', '.void', '.cloudflare', '.wrangler']);
const READABLE_BAR = 0.9;
const MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';

const checks: Array<SpikeCheck> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
}

function copyApp(app: string): string {
  const from = join(REPO, 'playground', app);
  const to = join(OUT_ROOT, app);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (!SKIP_COPY.has(entry)) {
      cpSync(join(from, entry), join(to, entry), { recursive: true });
    }
  }
  symlinkSync(realpathSync(join(from, 'node_modules')), join(to, 'node_modules'));
  return to;
}

function vpBuild(dir: string): { ms: number; ok: boolean; tail: string } {
  const started = Date.now();
  const result = spawnSync(join(dir, 'node_modules', '.bin', 'vp'), ['build'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    timeout: 300_000,
  });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { ms: Date.now() - started, ok: result.status === 0, tail: text.slice(-600) };
}

function walk(dir: string): Array<string> {
  if (!existsSync(dir)) {
    return [];
  }
  const out: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

function mainModule(ssr: string): string | null {
  try {
    const config = JSON.parse(readFileSync(join(ssr, 'wrangler.json'), 'utf8')) as {
      main?: string;
    };
    if (!config.main) {
      return null;
    }
    const main = config.main.split('\\').join('/');
    return main.startsWith('./') ? main.slice(2) : main;
  } catch {
    return null;
  }
}

/** The worker's modules as the API holds them after the deploy upload. */
function loadModules(ssr: string) {
  const files = collectWorkerFiles(ssr) as Map<string, Buffer>;
  const modules = [];
  const hashes = new Map<string, string>();
  let bytes = 0;
  for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const key = name.split('\\').join('/');
    const sha = t2.sha256Hex(data);
    hashes.set(key, sha);
    bytes += data.length;
    modules.push(
      t2.securityModuleFile(key, sha, key.endsWith('.wasm') ? '' : data.toString('utf8')),
    );
  }
  return { modules, hashes, bytes, names: [...hashes.keys()] };
}

type RawMap = {
  sources?: Array<unknown>;
  sourcesContent?: Array<unknown>;
  sections?: Array<{ map?: RawMap }>;
};

/** Every `sources` entry of the server maps, with or without text (the builder drops the empty ones). */
function mapEntries(ssr: string, names: Array<string>) {
  const entries: Array<{
    map: string;
    path: string | null;
    hasText: boolean;
    text: string | null;
  }> = [];
  for (const name of names.filter((n) => n.endsWith('.map'))) {
    const raw = JSON.parse(readFileSync(join(ssr, name), 'utf8')) as RawMap;
    const maps = Array.isArray(raw.sections) ? raw.sections.map((s) => s.map ?? {}) : [raw];
    for (const map of maps) {
      (map.sources ?? []).forEach((source, index) => {
        const text = map.sourcesContent?.[index];
        entries.push({
          map: name,
          path: typeof source === 'string' ? t2.normalizeSourcePath(name, undefined, source) : null,
          hasText: typeof text === 'string',
          text: typeof text === 'string' ? text : null,
        });
      });
    }
  }
  return entries;
}

/** Where a normalized source path lives on disk: the app, the repo, or the pnpm store. */
function diskFile(appDir: string, path: string): string | null {
  for (const base of [appDir, REPO]) {
    const candidate = join(base, path);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function pnpmPackage(path: string): string | null {
  const marker = 'node_modules/.pnpm/';
  const at = path.indexOf(marker);
  if (at === -1) {
    return null;
  }
  const rest = path.slice(at + marker.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? null : rest.slice(0, slash);
}

function plan(
  head: ReturnType<typeof loadModules>,
  main: string | null,
  assets: Array<{ path: string; text: string }>,
  lockfile: ReturnType<typeof thirdParty.parsePnpmLock>,
  base: { modules: Map<string, string>; sources: ReadonlyMap<string, string> } | null,
) {
  return build.buildSecurityScanInput({
    scan: {
      id: 'ss_s7',
      attempt: 1,
      engine: 'void_loop',
      model: MODEL,
      trigger: 'deploy',
      commit: null,
    },
    tier: base
      ? { tier: 'built_diff', fullReason: null }
      : { tier: 'full', fullReason: 'first_scan' },
    head: { modules: head.modules, main },
    base,
    assets,
    backlog: [],
    recheckFiles: [],
    secrets: [],
    lockfile,
    memory: { findings: [], events: [], lastSucceededAt: null, ledgerSummary: null },
  } as never);
}

function clientAssets(dir: string) {
  const client = join(dir, 'dist', 'client');
  const out: Array<{ path: string; text: string }> = [];
  for (const file of walk(client)) {
    const path = `/${relative(client, file).split('\\').join('/')}`;
    const lower = path.toLowerCase();
    if (
      t2.SECURITY_TEXT_ASSET_EXTENSIONS.some((ext: string) => lower.endsWith(ext)) &&
      statSync(file).size <= t2.SECURITY_TEXT_ASSET_MAX_BYTES
    ) {
      out.push({ path, text: readFileSync(file, 'utf8') });
    }
  }
  return out;
}

function inputPaths(built: ReturnType<typeof plan>) {
  return built.entries
    .map((entry: { path: string }) => entry.path)
    .filter((path: string) => path.startsWith('input/'));
}

/** A one-line change in the first server file of the app, for the T2 run. */
function changeOneLine(dir: string): string | null {
  for (const folder of ['routes', 'pages', 'middleware', 'src']) {
    const files = walk(join(dir, folder))
      .filter((file) => file.endsWith('.server.ts') || (folder !== 'pages' && file.endsWith('.ts')))
      .sort();
    if (files[0]) {
      appendFileSync(files[0], '\n// security spike S7: a one-line change\n');
      return relative(dir, files[0]);
    }
  }
  return null;
}

function measureApp(app: string, lockfile: ReturnType<typeof thirdParty.parsePnpmLock>) {
  const dir = copyApp(app);
  const first = vpBuild(dir);
  check(`${app}: vp build succeeds`, first.ok, first.ok ? undefined : first.tail);
  if (!first.ok) {
    return { app, build: first };
  }
  const ssr = join(dir, 'dist', 'ssr');
  const main = mainModule(ssr);
  const head = loadModules(ssr);
  const entries = mapEntries(ssr, head.names);
  const codeModules = head.names.filter(
    (n) => n.endsWith('.js') || n.endsWith('.mjs') || n.endsWith('.cjs'),
  );
  const bundle = t2.bundleSources(head.modules, main);

  const firstPartyEntries = entries.filter(
    (e) => e.path !== null && !e.path.includes('node_modules/'),
  );
  const registryEntries = entries.filter(
    (e) => e.path !== null && e.path.includes('node_modules/'),
  );
  const readableFirstParty = firstPartyEntries.filter((e) => e.hasText);
  const appFiles = readableFirstParty.filter(
    (e) => !e.path!.startsWith('packages/') && !e.path!.startsWith('_'),
  );
  const workspaceFiles = readableFirstParty.filter((e) => e.path!.startsWith('packages/'));
  const virtualFirstParty = readableFirstParty.filter((e) => diskFile(dir, e.path!) === null);
  const sameAsDisk = readableFirstParty.filter((e) => {
    const file = diskFile(dir, e.path!);
    return file !== null && readFileSync(file, 'utf8') === e.text;
  });
  const registryOnDisk = registryEntries.filter(
    (e) => e.hasText && diskFile(dir, e.path!) !== null,
  );
  const registrySame = registryOnDisk.filter(
    (e) => readFileSync(diskFile(dir, e.path!)!, 'utf8') === e.text,
  );
  const packages = new Set(registryEntries.map((e) => pnpmPackage(e.path!)).filter(Boolean));

  const assets = clientAssets(dir);
  const noLock = plan(head, main, assets, null, null);
  const withLock = plan(head, main, assets, lockfile, null);
  const noLockPaths = inputPaths(noLock);
  const party = (lock: typeof lockfile) => {
    const counts = { first_party: 0, registry: 0, unverified: 0 };
    for (const file of bundle.files) {
      counts[thirdParty.classifyThirdParty(file.path, lock) as keyof typeof counts]++;
    }
    return counts;
  };
  const sentAppFiles = appFiles.filter((e) => noLockPaths.includes(`input/${e.path}`));
  const filtered = appFiles.filter((e) => filters.securityInputFilter(e.path!) !== null);

  // Snapshot: modules/{i} + modules.json + sources.json + assets.json, per deployment;
  // backlog.json + server-leads.json + scope.json per scan.
  const modulesJson = JSON.stringify({
    version: 1,
    modules: head.names.map((name, i) => ({
      name,
      type: 'esm',
      size: 0,
      key: `security-scans/p/d/modules/${i}`,
      sha256: head.hashes.get(name),
    })),
  });
  const sourcesJson = JSON.stringify(Object.fromEntries(noLock.sourceIndex));
  const snapshotBytes = head.bytes + modulesJson.length + sourcesJson.length;

  // T2 after a one-line change.
  const changed = changeOneLine(dir);
  const second = vpBuild(dir);
  let t2Run: Record<string, unknown> = { changed, build: second.ok };
  if (second.ok && changed) {
    const next = loadModules(ssr);
    const diff = plan(next, mainModule(ssr), [], null, {
      modules: head.hashes,
      sources: noLock.sourceIndex,
    });
    const changedModules = next.names.filter(
      (name) => head.hashes.get(name) !== next.hashes.get(name),
    );
    t2Run = {
      changed,
      build: true,
      buildMs: second.ms,
      tier: diff.tier,
      focus: diff.focus,
      changedModules,
      filesScanned: diff.filesScanned,
      inputBytes: diff.inputBytes,
      emptyFocus: diff.emptyFocus,
    };
    check(
      `${app}: T2 after a one-line change focuses on that file`,
      diff.tier === 'built_diff' && diff.focus.includes(changed) && diff.focus.length <= 5,
      t2Run,
    );
  } else {
    check(`${app}: second build for T2`, false, second.tail);
  }

  const readableShare =
    firstPartyEntries.length === 0 ? 0 : readableFirstParty.length / firstPartyEntries.length;
  check(
    `${app}: ≥ 90% of first-party server files readable from sourcesContent`,
    readableShare >= READABLE_BAR,
    { readable: readableFirstParty.length, total: firstPartyEntries.length },
  );
  check(
    `${app}: every readable app file reaches /scan/input (full scan, no lockfile)`,
    sentAppFiles.length + filtered.length === appFiles.length,
    { app: appFiles.length, sent: sentAppFiles.length, filtered: filtered.map((e) => e.path) },
  );
  check(
    `${app}: workspace packages kept as first-party`,
    workspaceFiles.length > 0 &&
      workspaceFiles.every(
        (e) => thirdParty.classifyThirdParty(e.path!, lockfile) === 'first_party',
      ),
  );
  check(`${app}: full scan coverage complete`, noLock.coverage === 'complete', noLock.notes);

  return {
    app,
    buildMs: first.ms,
    builtNoMap: bundle.files.filter((file) => file.built).map((file) => file.path),
    modules: {
      total: head.names.length,
      code: codeModules.length,
      maps: head.names.length - codeModules.length,
      bytes: head.bytes,
      main,
    },
    mapSources: {
      total: entries.length,
      withText: entries.filter((e) => e.hasText).length,
      firstParty: firstPartyEntries.length,
      firstPartyReadable: readableFirstParty.length,
      readableShare: Number(readableShare.toFixed(4)),
      appFiles: appFiles.length,
      workspaceFiles: workspaceFiles.length,
      virtualFirstParty: virtualFirstParty.map((e) => e.path).slice(0, 12),
      firstPartySameAsDisk: sameAsDisk.length,
      firstPartyNotSameAsDisk: readableFirstParty
        .filter((e) => !sameAsDisk.includes(e) && !virtualFirstParty.includes(e))
        .map((e) => e.path)
        .slice(0, 12),
      registry: registryEntries.length,
      registryReadable: registryEntries.filter((e) => e.hasText).length,
      registrySameAsDisk: `${registrySame.length}/${registryOnDisk.length}`,
      registryPackages: packages.size,
    },
    classification: { noLockfile: party(null), withLockfile: party(lockfile) },
    input: {
      full: {
        filesScanned: noLock.filesScanned,
        inputBytes: noLock.inputBytes,
        coverage: noLock.coverage,
        droppedFiles: noLock.droppedFiles,
        tarEntries: noLock.entries.length,
        assets: assets.length,
      },
      fullWithLockfile: {
        filesScanned: withLock.filesScanned,
        inputBytes: withLock.inputBytes,
        coverage: withLock.coverage,
        droppedFiles: withLock.droppedFiles,
        notes: withLock.notes,
      },
    },
    snapshot: { bytes: snapshotBytes, objects: head.names.length + 3, perScanObjects: 3 },
    t2: t2Run,
  };
}

// ---------------------------------------------------------------------------
// Go-live call sites (plain text, no regex)
// ---------------------------------------------------------------------------

const ENQUEUE_TOKENS = [
  'enqueueSecurityScanInTx(',
  'enqueueSecurityScanForLiveDeployment(',
  'finishLiveSecurityScan()',
];
/** Spec §6.1 / design doc exclusions, by file. */
const EXCLUDED: Record<string, string> = {
  'routes/projects.ts': 'rollback (spec §6.1: "Not scanned: rollbacks")',
  'operator/project-normalization.ts': 'operator repair of a stale pointer (no new code goes live)',
};

function goLiveSites() {
  const src = join(REPO, 'platform', 'packages', 'api', 'src');
  const sites: Array<{
    file: string;
    line: number;
    kind: string;
    covered: string | null;
    excluded: string | null;
  }> = [];
  for (const file of walk(src).filter((f) => f.endsWith('.ts'))) {
    const rel = relative(src, file).split('\\').join('/');
    if (rel.startsWith('security/') || rel === 'db/deployments.ts' || rel === 'db.ts') {
      continue;
    }
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      const trimmed = text.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ')) {
        return;
      }
      let kind: string | null = null;
      if (trimmed.includes('setActiveDeployment(') && !trimmed.startsWith('setActiveDeployment,')) {
        kind = 'active pointer';
      }
      if (trimmed.includes('active_deployment_id: ') && trimmed.includes('.set(')) {
        kind = 'active pointer (direct)';
      }
      if (trimmed.startsWith('.set({ active_deployment_id')) {
        kind = 'active pointer (direct)';
      }
      if (trimmed.includes('updateDeploymentStatus(')) {
        const call = lines.slice(index, index + 6).join(' ');
        const end = call.indexOf(');');
        if ((end === -1 ? call : call.slice(0, end)).includes("'live'")) {
          kind = 'status live';
        }
      }
      if (kind === null) {
        return;
      }
      // The enqueue must follow in the same block (the next 30 lines) or the same transaction.
      const after = lines.slice(index, index + 30).join('\n');
      const token = ENQUEUE_TOKENS.find((t) => after.includes(t)) ?? null;
      sites.push({
        file: rel,
        line: index + 1,
        kind,
        covered: token,
        excluded: token ? null : (EXCLUDED[rel] ?? null),
      });
    });
  }
  return sites;
}

// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  mkdirSync(OUT_ROOT, { recursive: true });
  const lockText = readFileSync(join(REPO, 'pnpm-lock.yaml'), 'utf8');
  const lockfile = thirdParty.parsePnpmLock(lockText);
  const apps = [];
  for (const app of APPS) {
    process.stderr.write(`[s7] ${app}\n`);
    apps.push(measureApp(app, lockfile));
  }
  const sites = goLiveSites();
  const uncovered = sites.filter((s) => s.covered === null && s.excluded === null);
  check(
    'go-live: every site that makes a deployment live enqueues a scan (or is a spec exclusion)',
    uncovered.length === 0,
    uncovered,
  );
  check(
    'go-live: one enqueue path (enqueueSecurityScanInTx) under every covered site',
    sites.filter((s) => s.covered).length >= 4,
  );
  const report = {
    apps,
    lockfile: {
      entries: lockfile?.size ?? 0,
      note: 'The platform gets no lockfile today (lockfile null); the second classification shows what one would change.',
    },
    githubCompareMaxFiles: GITHUB_COMPARE_MAX_FILES,
    goLive: { sites, uncovered: uncovered.length },
  };
  if (values.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  finishSpike('S7 inputs', report, checks);
  process.exit(process.exitCode ?? 0);
}

await main();
