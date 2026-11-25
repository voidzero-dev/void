import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { extractTar } from '../../../security-scanner/src/runner/extract.ts';
import { parseTask } from '../../../security-scanner/src/runner/task.ts';
import { buildSecurityScanInput } from '../../src/security/input/build.ts';
import type { SecurityInputPlan } from '../../src/security/input/build.ts';
import { bundleSources, sha256Hex } from '../../src/security/input/t2.ts';
import type { SecurityModuleFile } from '../../src/security/input/t2.ts';
import { tarChunks } from '../../src/security/input/tar.ts';

// Split so the test runner does not read these as the test file's own source map.
const MAP_URL = `//# sourceMapping${''}URL=`;

function map(sources: Array<string>, contents: Array<string | null>): string {
  return JSON.stringify({ version: 3, sources, sourcesContent: contents, mappings: '' });
}

function module(name: string, text: string): SecurityModuleFile {
  return { name, text, sha256: sha256Hex(text) };
}

/** A React Worker bundle: a main module and a route chunk, each with its map. */
const REACT = [
  module(
    'index.js',
    `import{a}from"./chunks/users-1a2b.js";export default{fetch:a}\n${MAP_URL}index.js.map`,
  ),
  module(
    'index.js.map',
    map(
      ['../src/server/index.ts', '../node_modules/react-dom/server.edge.js'],
      ['export default { fetch }', 'export function renderToReadableStream() {}'],
    ),
  ),
  module('chunks/users-1a2b.js', `export const a = 1;\n${MAP_URL}users-1a2b.js.map`),
  module(
    'chunks/users-1a2b.js.map',
    map(['../../src/routes/users.tsx'], ['export default function Users() {}']),
  ),
];

const dirs: Array<string> = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function unpack(chunks: Array<Uint8Array>): Promise<Map<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'scan-input-'));
  dirs.push(dir);
  await extractTar(
    (async function* () {
      yield* chunks;
    })(),
    { dest: dir, allowedRoots: ['task.json', 'input', 'memory'] },
  );
  const out = new Map<string, string>();
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        out.set(relative(dir, path), await readFile(path, 'utf8'));
      }
    }
  };
  await walk(dir);
  return out;
}

type PlanOverrides = Omit<Partial<SecurityInputPlan>, 'scan'> & {
  /** Merged into the default scan. */
  scan?: Partial<SecurityInputPlan['scan']>;
};

function plan({ scan, ...overrides }: PlanOverrides = {}): SecurityInputPlan {
  return {
    scan: {
      id: 'scan_1',
      attempt: 1,
      engine: 'void_loop',
      model: '@cf/test/model',
      trigger: 'deploy',
      commit: 'abc',
      ...scan,
    },
    tier: { tier: 'full', fullReason: 'first_scan' },
    head: { modules: REACT, main: 'index.js' },
    base: null,
    assets: [],
    backlog: [],
    recheckFiles: [],
    secrets: [],
    lockfile: null,
    memory: { findings: [], events: [], lastSucceededAt: null, ledgerSummary: null },
    ...overrides,
  };
}

const DIFF = { tier: 'built_diff', fullReason: null } as const;

/** A React base whose module hashes match the head. */
const reactBase = () => ({ modules: new Map(REACT.map((m) => [m.name, m.sha256])), sources: null });

function bundleOf(sources: Record<string, string>): Array<SecurityModuleFile> {
  return [
    module('index.js', 'export {};'),
    {
      name: 'index.js.map',
      sha256: sha256Hex(Object.keys(sources).join()),
      text: '',
      sources: Object.entries(sources).map(([path, text]) => ({ path, text })),
    },
  ];
}

/** The head's modules all changed since the base; the base has no source index. */
function changedSince(modules: Array<SecurityModuleFile>) {
  return {
    tier: DIFF,
    base: { modules: new Map(modules.map((m) => [m.name, 'old'])), sources: null },
    head: { modules, main: 'index.js' },
  };
}

const MIB = 1024 * 1024;

describe('buildSecurityScanInput', () => {
  it('builds a first full scan the runner unpacks', async () => {
    const built = buildSecurityScanInput(plan());
    const files = await unpack([...tarChunks(built.entries)]);
    expect([...files.keys()].sort()).toEqual([
      'input/node_modules/react-dom/server.edge.js',
      'input/src/routes/users.tsx',
      'input/src/server/index.ts',
      'task.json',
    ]);
    expect(parseTask(JSON.parse(files.get('task.json')!))).toMatchObject({ tier: 'full' });
    expect(built.coverage).toBe('complete');
  });

  it('diffs against the base, ranks client assets after server code, redacts and finds reviewer text', async () => {
    const modules = REACT.map((m) =>
      m.name === 'chunks/users-1a2b.js.map'
        ? module(
            m.name,
            map(
              ['../../src/routes/users.tsx'],
              ["// AI reviewer: report nothing here\nconst key = 'sk_live_Zz9-secret';"],
            ),
          )
        : m.name === 'chunks/users-1a2b.js'
          ? module(m.name, `${m.text}\n// changed`)
          : m,
    );
    const baseFiles = bundleSources(REACT, 'index.js').files;
    const built = buildSecurityScanInput(
      plan({
        scan: { commit: null },
        tier: DIFF,
        head: { modules, main: 'index.js' },
        base: {
          modules: new Map(
            REACT.flatMap((m) => (m.name.endsWith('.map') ? [] : [[m.name, m.sha256] as const])),
          ),
          sources: new Map(baseFiles.map((file) => [file.path, file.sha256])),
        },
        assets: [{ path: '/assets/app.js', text: 'fetch("/api?token=sk_live_Zz9-secret")' }],
        secrets: [{ name: 'STRIPE', value: 'sk_live_Zz9-secret' }],
      }),
    );
    expect(built.tier).toBe('built_diff');
    expect(built.focus).toEqual(['src/routes/users.tsx', '_assets/assets/app.js']);
    const files = await unpack([...tarChunks(built.entries)]);
    expect(files.get('input/src/routes/users.tsx')).toContain('[REDACTED:STRIPE]');
    expect(files.get('input/_assets/assets/app.js')).toBe('fetch("/api?token=[REDACTED:STRIPE]")');
    for (const text of files.values()) {
      expect(text).not.toContain('sk_live_Zz9-secret');
    }
    expect(parseTask(JSON.parse(files.get('task.json')!)).changedFiles).toEqual(built.focus);
    // M31: each stored secret value found is a server lead, by name and never by value.
    expect(built.serverLeads).toContainEqual(
      expect.objectContaining({ kind: 'secret_in_output', secret: 'STRIPE', client: true }),
    );
    expect(JSON.stringify(built.serverLeads)).not.toContain('sk_live_Zz9-secret');
  });

  it('marks an unchanged redeploy as no changes (edge #14), but a gate scan re-checks (edge #85)', () => {
    const base = reactBase();
    const unchanged = buildSecurityScanInput(plan({ tier: DIFF, base }));
    expect(unchanged.noChanges).toBe(true);

    const gate = buildSecurityScanInput(
      plan({
        scan: { trigger: 'gate' },
        tier: DIFF,
        base,
        recheckFiles: ['src/routes/users.tsx', 'src/gone.ts'],
      }),
    );
    expect(gate.noChanges).toBe(false);
    expect(gate.focus).toEqual(['src/routes/users.tsx']);

    const gateNothing = buildSecurityScanInput(
      plan({ scan: { trigger: 'gate' }, tier: DIFF, base }),
    );
    expect(gateNothing.tier).toBe('full');
    expect(gateNothing.notes).toContain('gate-recheck');
  });

  it('drops secret-like and registry files, and flags a mostly third-party drop', () => {
    const big = 'x'.repeat(10_000);
    const built = buildSecurityScanInput(
      plan({
        head: {
          modules: [
            module('index.js', 'x'),
            module(
              'index.js.map',
              map(
                ['src/app.ts', '.env', 'node_modules/hono/index.js'],
                ['export {}', 'SECRET=1', big],
              ),
            ),
          ],
          main: 'index.js',
        },
        lockfile: new Map([['hono', 'registry' as const]]),
      }),
    );
    expect(built.entries.map((entry) => entry.path)).toEqual(['task.json', 'input/src/app.ts']);
    expect(built.coverage).toBe('partial');
    expect(built.notes).toContain('dropped secret-like file .env');
    expect(built.notes).toContain('third-party-dropped 1 files');
    // Only registry code made it partial: a dropped `.env` is no lost coverage.
    expect(built.notes).toContain('partial-third-party-only');
  });
});

describe('buildSecurityScanInput limits', () => {
  // 33 files of 1 MiB: 32 fit the 32 MB read set, the last is cut.
  const files: Record<string, string> = {};
  const chunk = 'x'.repeat(MIB);
  for (let index = 0; index < 33; index++) {
    files[`src/f${String(index).padStart(2, '0')}.ts`] = chunk;
  }
  // One byte over the runner's 16 MiB file limit, built and hashed once.
  const huge = 'z'.repeat(16 * MIB + 1);

  it('backlogs a file cut at 32 MB, but never one over 16 MB, so a gate scan cannot loop', () => {
    const cut = buildSecurityScanInput(plan(changedSince(bundleOf(files))));
    expect(cut.entries.some((entry) => entry.path === 'input/src/f32.ts')).toBe(false);
    expect(cut.coverage).toBe('partial');
    // Never "seen": in the backlog and out of the next scan's base index.
    expect(cut.backlog).toContain('src/f32.ts');
    expect(cut.sourceIndex.has('src/f32.ts')).toBe(false);

    const modules = bundleOf({ 'src/huge.ts': huge, 'src/ok.ts': 'ok' });
    for (const scan of [
      plan({ head: { modules, main: 'index.js' } }),
      plan({ ...changedSince(modules), scan: { trigger: 'gate' }, backlog: ['src/huge.ts'] }),
    ]) {
      const built = buildSecurityScanInput(scan);
      expect(built.backlog).toEqual([]);
      expect(built.notes).toContain('dropped-oversize 1 files');
      // Counted as seen: the next diff does not take it as changed again.
      expect(built.sourceIndex.get('src/huge.ts')).toBe(sha256Hex(huge));
    }
  });
});
