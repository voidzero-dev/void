import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildHeaders, isStaleBuild } from '../../../edge/src/pages-protocol.ts';
import { computePagesBuildId, endPagesBuild } from '../../src/pages/build-id-source.ts';
import { pagesBuildId } from '../../src/pages/build-id.ts';
import { createPagesPlugin } from '../../src/pages/plugin.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const roots: Array<string> = [];

/** A fresh folder, removed after the test. */
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  // Each test stands for its own build process.
  endPagesBuild();
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
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
    const root = tempRoot('void-build-id-');
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'pages/index.tsx'), content);
    return root;
  }

  /** The id a new build of `root` gets. */
  function buildIdOf(root: string, excludeDirs: Array<string> = []): string {
    endPagesBuild(root);
    return computePagesBuildId(root, excludeDirs);
  }

  it('hashes the source, so identical trees keep the id', () => {
    const content = 'export default function Page() {}\n';
    expect(buildIdOf(createSourceFixture(content))).toBe(buildIdOf(createSourceFixture(content)));
  });

  it('recomputes when a file changes', () => {
    const root = createSourceFixture('export default function Page() {}\n');
    const first = buildIdOf(root);

    writeFileSync(join(root, 'pages/index.tsx'), 'export default function Page() { return 1 }\n');

    expect(buildIdOf(root)).not.toBe(first);
  });

  it('keeps the first id until the build ends, whatever changes meanwhile', () => {
    const root = createSourceFixture('export default function Page() {}\n');
    const first = computePagesBuildId(root, []);

    // Another task writes while Vite resolves the next environment.
    writeFileSync(join(root, 'pages/index.tsx'), 'export default function Page() { return 1 }\n');
    expect(computePagesBuildId(root, [])).toBe(first);

    endPagesBuild(root);
    expect(computePagesBuildId(root, [])).not.toBe(first);
  });

  it('reuses the id while size and modification time still match', () => {
    const root = createSourceFixture('export default function Page() {}\n');
    const path = join(root, 'pages/index.tsx');
    // A whole second, so the restored timestamp is byte for byte the old one.
    const stamp = 1_700_000_000;
    utimesSync(path, stamp, stamp);
    const first = buildIdOf(root);

    // Same size, and the mtime put back: nothing a build can observe changed.
    writeFileSync(path, 'export default function Home() {}\n');
    utimesSync(path, stamp, stamp);
    expect(buildIdOf(root)).toBe(first);

    // The content really did change, so a fresh pass must notice.
    rmSync(join(root, '.void'), { recursive: true, force: true });
    expect(buildIdOf(root)).not.toBe(first);
  });

  it('ignores build output, dot directories, .env files and installed packages', () => {
    const root = createSourceFixture('export default function Page() {}\n');
    const first = buildIdOf(root, [join(root, 'dist')]);

    for (const dir of ['dist', 'node_modules/pkg', '.void', '.wrangler']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'generated.js'), 'changed\n');
    }
    writeFileSync(join(root, '.env.local'), 'SECRET=1\n');

    expect(buildIdOf(root, [join(root, 'dist')])).toBe(first);
  });

  it('counts dot files that configure the build', () => {
    const root = createSourceFixture('export default function Page() {}\n');
    const first = buildIdOf(root);

    writeFileSync(join(root, '.browserslistrc'), 'last 1 chrome version\n');

    expect(buildIdOf(root)).not.toBe(first);
  });

  describe('in a workspace', () => {
    /** A pnpm-style workspace: the app links the ui package into its node_modules. */
    function createWorkspace(appDir = 'apps/web') {
      const workspace = tempRoot('void-build-id-workspace-');
      const write = (path: string, content: string) => {
        mkdirSync(dirname(join(workspace, path)), { recursive: true });
        writeFileSync(join(workspace, path), content);
      };
      write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
      write('packages/ui/package.json', '{"name":"ui"}');
      write('packages/ui/index.ts', 'export const label = 1;\n');
      write('apps/docs/package.json', '{"name":"docs"}');
      write(`${appDir}/package.json`, '{"name":"web","dependencies":{"ui":"workspace:*"}}');
      write(`${appDir}/pages/index.tsx`, "import { label } from 'ui';\n");
      mkdirSync(join(workspace, appDir, 'node_modules'), { recursive: true });
      symlinkSync(
        join(workspace, 'packages/ui'),
        join(workspace, appDir, 'node_modules/ui'),
        'dir',
      );
      return { app: join(workspace, appDir), write };
    }

    it('covers the workspace packages the app depends on, and the lockfile', () => {
      const { app, write } = createWorkspace();
      const first = buildIdOf(app);

      write('packages/ui/index.ts', 'export const label = 22;\n');
      const second = buildIdOf(app);
      expect(second).not.toBe(first);

      write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
      expect(buildIdOf(app)).not.toBe(second);
    });

    it('ignores workspace packages the app does not use', () => {
      const { app, write } = createWorkspace();
      const first = buildIdOf(app);

      // A sibling app building at the same time.
      write('apps/docs/dist/index.js', 'built\n');

      expect(buildIdOf(app)).toBe(first);
    });

    it('covers an app that sits under a dot folder', () => {
      const { app, write } = createWorkspace('.examples/web');
      const first = buildIdOf(app);

      write('.examples/web/pages/index.tsx', 'export default 2;\n');

      expect(buildIdOf(app)).not.toBe(first);
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'skips a folder the build cannot read',
    () => {
      const root = createSourceFixture('export default function Page() {}\n');
      mkdirSync(join(root, 'pgdata/base'), { recursive: true });
      chmodSync(join(root, 'pgdata'), 0o000);
      try {
        expect(buildIdOf(root)).toHaveLength(12);
      } finally {
        chmodSync(join(root, 'pgdata'), 0o700);
      }
    },
  );
});

describe('createPagesPlugin build id', () => {
  type BuildConfig = { define?: Record<string, string> } | undefined;
  type PagesConfigHook = (
    userConfig: Record<string, unknown>,
    env: { command: 'build' | 'serve' },
  ) => Promise<BuildConfig>;

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
    const hook = getHookHandler(plugin.config) as unknown as (
      userConfig: Record<string, unknown>,
      env: { command: 'build' | 'serve'; mode: string },
    ) => Promise<BuildConfig>;
    // Vite always passes a mode; the tests only vary the command.
    return (userConfig, env) => hook(userConfig, { mode: 'production', ...env });
  }

  function createFixture(): string {
    const root = tempRoot('void-pages-build-');
    const pagesDir = join(root, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, 'index.tsx'), 'export default function Page() {}\n');
    return root;
  }

  const DEFINE = 'import.meta.env.__VOID_PAGES_BUILD_ID';

  function idIn(config: BuildConfig): string | undefined {
    return config?.define?.[DEFINE];
  }

  it('defines one id for a build, shared by every environment', async () => {
    const config = createConfigHook();

    const id = idIn(await config({}, { command: 'build' }));
    expect(JSON.parse(id ?? '""')).toMatch(/^[0-9a-f]{12}$/);
    // Both bundles must carry the same id, or every navigation would reload.
    expect(idIn(await config({}, { command: 'build' }))).toBe(id);
  });

  it('keeps one id when each environment evaluates the config to another define', async () => {
    const root = createFixture();
    // Vite evaluates vite.config.ts again per environment, with a new plugin each
    // time, so a define such as Date.now() differs between the two bundles.
    const client = await createConfigHook(root)(
      { define: { __BUILT_AT__: '"1"' } },
      { command: 'build' },
    );
    const server = await createConfigHook(root)(
      { define: { __BUILT_AT__: '"2"' } },
      { command: 'build' },
    );

    expect(idIn(server)).toBe(idIn(client));
  });

  it('hashes again once the build ends, for the next build in this process', async () => {
    const root = createFixture();
    const plugin = createPagesPlugin(join(root, 'pages'), {
      name: 'test:pages',
      generateRenderer: () => '',
      generateClient: () => '',
      config: () => ({}),
    });
    const first = idIn(await createConfigHook(root)({}, { command: 'build' }));

    writeFileSync(join(root, 'pages', 'index.tsx'), 'export default function Other() {}\n');
    const endBuild = getHookHandler(plugin.buildApp) as unknown as () => Promise<void>;
    await endBuild();

    expect(idIn(await createConfigHook(root)({}, { command: 'build' }))).not.toBe(first);
  });

  it('derives the id from the app source, so identical sources keep it', async () => {
    const root = createFixture();
    const idOf = async () => {
      endPagesBuild(root);
      return idIn(await createConfigHook(root)({}, { command: 'build' }));
    };

    const first = await idOf();
    expect(await idOf()).toBe(first);

    writeFileSync(join(root, 'pages', 'index.tsx'), 'export default function Other() {}\n');
    expect(await idOf()).not.toBe(first);
  });

  it('changes the id for env values the client inlines', async () => {
    const root = createFixture();
    const idFor = async (value: string) => {
      vi.stubEnv('VITE_PROBE', value);
      endPagesBuild(root);
      return idIn(await createConfigHook(root)({}, { command: 'build' }));
    };

    // Two builds that differ only here still emit different chunks.
    expect(await idFor('one')).not.toBe(await idFor('two'));
  });

  it('changes the id for an app define the client inlines', async () => {
    // Two apps with the same source, built apart, that differ only in a define.
    const idFor = async (value: string) =>
      idIn(
        await createConfigHook(createFixture())(
          { define: { __PROBE__: JSON.stringify(value) } },
          { command: 'build' },
        ),
      );

    expect(await idFor('one')).not.toBe(await idFor('two'));
  });

  it('defines nothing when deploy recovery is off', async () => {
    const config = createConfigHook(undefined, { deployRecovery: false });

    expect(await config({}, { command: 'build' })).toEqual({});
  });

  it('defines nothing in the dev server, which serves one build', async () => {
    const config = createConfigHook();

    expect(await config({}, { command: 'serve' })).toEqual({});
  });

  it('leaves an id the app defines to Vite, without hashing the tree', async () => {
    const root = createFixture();
    const config = createConfigHook(root);

    const pinned = await config({ define: { [DEFINE]: '"commit-abc"' } }, { command: 'build' });

    expect(idIn(pinned)).toBeUndefined();
    expect(existsSync(join(root, '.void'))).toBe(false);
  });
});
