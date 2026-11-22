import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildHeaders, isStaleBuild } from '../../../edge/src/pages-protocol.ts';
import { computePagesBuildId } from '../../src/pages/build-id-source.ts';
import { pagesBuildId } from '../../src/pages/build-id.ts';
import { createPagesPlugin } from '../../src/pages/plugin.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pagesBuildId', () => {
  it('reads the id the build defines', () => {
    vi.stubEnv('__VOID_PAGES_BUILD_ID', 'build-2');
    expect(pagesBuildId()).toBe('build-2');
  });

  it('is empty where no build defined one, which disables every check', () => {
    expect(pagesBuildId()).toBe('');
  });
});

describe('isStaleBuild', () => {
  it.each([
    ['another build', 'build-2', 'build-1', true],
    ['the same build', 'build-2', 'build-2', false],
    ['no id on the wire', 'build-2', null, false],
    ['the header missing', 'build-2', undefined, false],
    ['no id in this bundle', '', 'build-1', false],
  ])('%s', (_, buildId, seen, expected) => {
    expect(isStaleBuild(buildId, seen)).toBe(expected);
  });
});

describe('buildHeaders', () => {
  it('carries the build only when one is known', () => {
    expect(buildHeaders('')).toEqual({});
    expect(buildHeaders('build-2')).toEqual({ 'X-VoidPages-Build': 'build-2' });
  });
});

describe('computePagesBuildId', () => {
  function createSourceFixture(content: string): string {
    const root = mkdtempSync(join(tmpdir(), 'void-build-id-'));
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'pages/index.tsx'), content);
    return root;
  }

  it('hashes the source, so identical trees keep the id', () => {
    const content = 'export default function Page() {}\n';
    expect(computePagesBuildId(createSourceFixture(content), [])).toBe(
      computePagesBuildId(createSourceFixture(content), []),
    );
  });

  it('recomputes when a file changes', () => {
    const root = createSourceFixture('export default function Page() {}\n');
    const first = computePagesBuildId(root, []);

    writeFileSync(join(root, 'pages/index.tsx'), 'export default function Page() { return 1 }\n');

    expect(computePagesBuildId(root, [])).not.toBe(first);
  });

  it('reuses the id while size and modification time still match', () => {
    const root = createSourceFixture('export default function Page() {}\n');
    const path = join(root, 'pages/index.tsx');
    // A whole second, so the restored timestamp is byte for byte the old one.
    const stamp = 1_700_000_000;
    utimesSync(path, stamp, stamp);
    const first = computePagesBuildId(root, []);

    // Same size, and the mtime put back: nothing a build can observe changed.
    writeFileSync(path, 'export default function Home() {}\n');
    utimesSync(path, stamp, stamp);
    expect(computePagesBuildId(root, [])).toBe(first);

    // The content really did change, so a fresh pass must notice.
    rmSync(join(root, '.void'), { recursive: true, force: true });
    expect(computePagesBuildId(root, [])).not.toBe(first);
  });

  it('ignores build output, dot directories and installed packages', () => {
    const root = createSourceFixture('export default function Page() {}\n');
    const first = computePagesBuildId(root, [join(root, 'dist')]);

    for (const dir of ['dist', 'node_modules/pkg', '.void', '.wrangler']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'generated.js'), 'changed\n');
    }

    expect(computePagesBuildId(root, [join(root, 'dist')])).toBe(first);
  });
});

describe('createPagesPlugin build id', () => {
  type PagesConfigHook = (
    userConfig: Record<string, unknown>,
    env: { command: 'build' | 'serve' },
  ) => Promise<{ define?: Record<string, string> } | undefined>;

  function createConfigHook(
    root?: string,
    pluginOptions: { deployRecovery?: boolean } = {},
  ): PagesConfigHook {
    const appRoot = root ?? createFixture();
    const plugin = createPagesPlugin(join(appRoot, 'pages'), {
      name: 'test:pages',
      generateRenderer: () => '',
      generateClient: () => '',
      config: () => ({}),
      ...pluginOptions,
    });
    return getHookHandler(plugin.config) as unknown as PagesConfigHook;
  }

  function createFixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'void-pages-build-'));
    const pagesDir = join(root, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, 'index.tsx'), 'export default function Page() {}\n');
    return root;
  }

  const DEFINE = 'import.meta.env.__VOID_PAGES_BUILD_ID';

  it('defines one id for a build, shared by every environment', async () => {
    const config = createConfigHook();

    const client = await config({}, { command: 'build' });
    const server = await config({}, { command: 'build' });

    const id = client!.define![DEFINE]!;
    expect(JSON.parse(id)).toMatch(/^[0-9a-f]{12}$/);
    // Both bundles must carry the same id, or every navigation would reload.
    expect(server!.define![DEFINE]).toBe(id);
  });

  it('derives the id from the app source, so identical sources keep it', async () => {
    const root = createFixture();
    const idOf = async () =>
      (await createConfigHook(root)({}, { command: 'build' }))!.define![DEFINE];

    const first = await idOf();
    expect(await idOf()).toBe(first);

    writeFileSync(join(root, 'pages', 'index.tsx'), 'export default function Other() {}\n');
    expect(await idOf()).not.toBe(first);
  });

  it('defines nothing when deploy recovery is off', async () => {
    const config = createConfigHook(undefined, { deployRecovery: false });

    expect(await config({}, { command: 'build' })).toEqual({});
  });

  it('defines nothing in the dev server, which serves one build', async () => {
    const config = createConfigHook();

    expect(await config({}, { command: 'serve' })).toEqual({});
  });

  it('lets an explicit define pin the id', async () => {
    const config = createConfigHook();

    const pinned = await config({ define: { [DEFINE]: '"commit-abc"' } }, { command: 'build' });

    expect(pinned!.define![DEFINE]).toBe('"commit-abc"');
  });
});
