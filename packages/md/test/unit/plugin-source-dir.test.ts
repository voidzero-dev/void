import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { voidMarkdown } from '../../src/plugin.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = join(
    tmpdir(),
    `void-md-source-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  tempDirs.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'void.json'), JSON.stringify({ sourceDir: 'src' }));
  mkdirSync(join(root, 'src', 'pages', 'posts'), { recursive: true });
  return root;
}

function getHookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

function createPlugin(): Plugin {
  const [plugin] = voidMarkdown();
  return plugin;
}

describe('voidMarkdown sourceDir support', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('scans markdown pages under sourceDir', async () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'pages', 'posts', 'hello.md'),
      '<script>\ndocument.body.dataset.md = "ready";\n</script>\n\n# Hello\n',
    );

    const plugin = createPlugin();
    const configResolved = getHookHandler(plugin.configResolved) as (
      config: import('vite').ResolvedConfig,
    ) => void;
    const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;
    const load = getHookHandler(plugin.load) as (id: string) => string | undefined;

    configResolved({
      root,
      plugins: [{ name: 'void-react:pages' }],
    } as unknown as import('vite').ResolvedConfig);
    await buildStart.call({} as never);

    expect(load('\0void-md-pages')).toContain('/posts/hello');
    expect(load('\0' + 'virtual:void-md-client')).toContain('virtual:void-md-script:posts/hello');
  });

  async function scanForCommand(root: string, command: 'serve' | 'build') {
    const plugin = createPlugin();
    const config = getHookHandler(plugin.config) as (
      config: { root: string },
      env: { command: 'serve' | 'build'; isPreview?: boolean },
    ) => unknown;
    const configResolved = getHookHandler(plugin.configResolved) as (
      config: import('vite').ResolvedConfig,
    ) => void;
    const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;
    const load = getHookHandler(plugin.load) as (id: string) => string | undefined;

    config({ root }, { command });
    configResolved({
      root,
      plugins: [{ name: 'void-react:pages' }],
    } as unknown as import('vite').ResolvedConfig);
    await buildStart.call({} as never);

    const source = load('\0void-md-pages')!;
    const pages = JSON.parse(source.slice('export default '.length, -1)) as Array<{
      path: string;
    }>;
    return {
      paths: pages.map((page) => page.path),
      clientEntry: load('\0' + 'virtual:void-md-client'),
    };
  }

  it('lists .dev markdown pages without the suffix only on the dev server', async () => {
    const root = createTempRoot();
    const pagesDir = join(root, 'src', 'pages');
    writeFileSync(
      join(pagesDir, 'debug.dev.md'),
      '<script>\ndocument.body.dataset.md = "debug";\n</script>\n\n# Debug\n',
    );
    writeFileSync(join(pagesDir, 'index.dev.md'), '# Dev home\n');
    writeFileSync(join(pagesDir, 'posts', 'hello.md'), '# Hello\n');

    const serve = await scanForCommand(root, 'serve');
    expect(serve.paths).toEqual(['/', '/debug', '/posts/hello']);
    expect(serve.clientEntry).toContain('virtual:void-md-script:debug.dev');

    const build = await scanForCommand(root, 'build');
    expect(build.paths).toEqual(['/posts/hello']);
    expect(build.clientEntry).not.toContain('debug.dev');
  });

  it('lists .prod markdown pages only in builds', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'src', 'pages', 'posts', 'stats.prod.md'), '# Stats\n');

    expect((await scanForCommand(root, 'serve')).paths).toEqual([]);
    expect((await scanForCommand(root, 'build')).paths).toEqual(['/posts/stats']);
  });

  it('adds the markdown client entry for sourceDir pages with scripts and islands', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'pages', 'posts', 'hello.md'),
      '<script>\ndocument.body.dataset.md = "ready";\n</script>\n\n# Hello\n',
    );
    writeFileSync(join(root, 'src', 'pages', 'posts', 'Counter.island.tsx'), 'export default {};');

    const plugin = createPlugin();
    const config = getHookHandler(plugin.config) as (
      config: { root: string },
      env: { command: 'build' },
    ) => unknown;

    expect(config({ root }, { command: 'build' })).toEqual({
      environments: {
        client: {
          build: {
            rollupOptions: {
              input: { 'md-client': 'virtual:void-md-client' },
            },
          },
        },
      },
    });
  });
});
