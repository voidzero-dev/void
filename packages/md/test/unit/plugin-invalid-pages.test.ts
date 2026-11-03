import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tinyglobby from 'tinyglobby';
import type { ResolvedConfig, ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { scanPages } from 'void/pages';
import { extractMetadata } from '../../src/metadata.ts';
import { voidMarkdown } from '../../src/plugin.ts';

vi.mock('tinyglobby', { spy: true });

const VALID = '---\ntitle: Good title\n---\n\n# Hello\n';
const INVALID = '---\ntitle\ndescription: Missing colon above\n---\n\n# Hello\n';
const OTHER_INVALID = '---\ntitle: [unclosed\n---\n\n# Hello\n';

type WatcherListener = (file: string) => Promise<void>;
type MdPageEntry = { path: string; title: string };

function getHookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

const tempDirs: Array<string> = [];

function createApp(pages: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'void-md-invalid-pages-'));
  tempDirs.push(root);
  const pagesDir = join(root, 'pages');
  mkdirSync(pagesDir);
  for (const [file, content] of Object.entries(pages)) {
    writeFileSync(join(pagesDir, file), content);
  }
  return { root, pagesDir };
}

async function startPlugin(root: string, command: 'serve' | 'build') {
  const [plugin] = voidMarkdown();
  const logError = vi.fn<(message: string) => void>();
  const logger = { error: logError } as unknown as ResolvedConfig['logger'];

  const config = getHookHandler(plugin.config) as (
    config: { root: string },
    env: { command: 'serve' | 'build' },
  ) => unknown;
  const configResolved = getHookHandler(plugin.configResolved) as (config: ResolvedConfig) => void;
  const buildStart = getHookHandler(plugin.buildStart) as () => Promise<void>;
  const load = getHookHandler(plugin.load) as (id: string) => string | undefined;
  const configureServer = getHookHandler(plugin.configureServer) as (server: ViteDevServer) => void;
  const transform = getHookHandler(plugin.transform) as (
    code: string,
    id: string,
  ) => Promise<{ code: string }>;

  await config({ root }, { command });
  configResolved({
    root,
    plugins: [{ name: 'void-react:pages' }],
    logger,
  } as unknown as ResolvedConfig);

  return {
    logError,
    scan: () => buildStart.call({} as never),
    transform: (code: string, id: string) => transform.call({} as never, code, id),
    listPages(): Array<MdPageEntry> {
      const source = load('\0void-md-pages')!;
      return JSON.parse(source.slice('export default '.length, -1)) as Array<MdPageEntry>;
    },
    /** Attach to a stub dev server and return the plugin's own watcher listener. */
    watchPages(): WatcherListener {
      let listener: WatcherListener | undefined;
      configureServer({
        config: { logger },
        moduleGraph: { getModuleById: () => undefined },
        watcher: {
          on(event: string, callback: WatcherListener) {
            if (event === 'change') {
              listener = callback;
            }
          },
        },
      } as unknown as ViteDevServer);
      return listener!;
    },
  };
}

afterEach(() => {
  vi.mocked(tinyglobby.glob).mockReset();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('voidMarkdown invalid pages on the dev server', () => {
  it('starts with an invalid page, leaving out only that page', async () => {
    const { root } = createApp({ 'broken.md': INVALID, 'other.md': VALID });
    const plugin = await startPlugin(root, 'serve');

    await plugin.scan();

    expect(plugin.listPages().map((page) => page.path)).toEqual(['/other']);
    expect(plugin.logError).toHaveBeenCalledOnce();
    expect(plugin.logError.mock.calls[0]?.[0]).toContain('pages/broken.md');
    expect(plugin.logError.mock.calls[0]?.[0]).toContain('Invalid frontmatter');
  });

  it('survives a page saved with invalid frontmatter and keeps its last good entry', async () => {
    const { root, pagesDir } = createApp({ 'index.md': VALID });
    const plugin = await startPlugin(root, 'serve');
    await plugin.scan();
    const onChange = plugin.watchPages();

    writeFileSync(join(pagesDir, 'index.md'), INVALID);
    // A rejection here is an unhandled rejection in Vite's watcher, which exits the process.
    await expect(onChange(join(pagesDir, 'index.md'))).resolves.toBeUndefined();

    expect(plugin.listPages()).toMatchObject([{ path: '/', title: 'Good title' }]);
    expect(plugin.logError.mock.calls[0]?.[0]).toContain('pages/index.md');
  });

  it('picks the page up again once its frontmatter is fixed', async () => {
    const { root, pagesDir } = createApp({ 'index.md': INVALID });
    const plugin = await startPlugin(root, 'serve');
    await plugin.scan();
    expect(plugin.listPages()).toEqual([]);
    const onChange = plugin.watchPages();

    writeFileSync(join(pagesDir, 'index.md'), VALID);
    await onChange(join(pagesDir, 'index.md'));

    expect(plugin.listPages()).toMatchObject([{ path: '/', title: 'Good title' }]);
  });

  it('logs a page error once per failure across rescans', async () => {
    const { root, pagesDir } = createApp({ 'index.md': VALID, 'other.md': VALID });
    const plugin = await startPlugin(root, 'serve');
    await plugin.scan();
    const onChange = plugin.watchPages();
    const index = join(pagesDir, 'index.md');
    const other = join(pagesDir, 'other.md');

    writeFileSync(index, INVALID);
    await onChange(index);
    // Saving an unrelated page rescans the invalid one too.
    await onChange(other);
    expect(plugin.logError).toHaveBeenCalledTimes(1);

    // A different mistake in the same page is news.
    writeFileSync(index, OTHER_INVALID);
    await onChange(index);
    expect(plugin.logError).toHaveBeenCalledTimes(2);

    // So is the same mistake coming back after a fix.
    writeFileSync(index, VALID);
    await onChange(index);
    writeFileSync(index, OTHER_INVALID);
    await onChange(index);
    expect(plugin.logError).toHaveBeenCalledTimes(3);
  });

  it('skips a page removed during the scan without reporting it', async () => {
    const { root, pagesDir } = createApp({ 'index.md': VALID });
    const plugin = await startPlugin(root, 'serve');
    await plugin.scan();
    const onChange = plugin.watchPages();

    // The glob result is stale by the time the file is read, as when switching branches.
    vi.mocked(tinyglobby.glob).mockResolvedValueOnce(['index.md', 'removed.md']);
    await expect(onChange(join(pagesDir, 'index.md'))).resolves.toBeUndefined();

    expect(plugin.listPages().map((page) => page.path)).toEqual(['/']);
    expect(plugin.logError).not.toHaveBeenCalled();
  });

  it('keeps the last good pages when the scan itself fails', async () => {
    const { root, pagesDir } = createApp({ 'index.md': VALID });
    const plugin = await startPlugin(root, 'serve');
    await plugin.scan();
    const onChange = plugin.watchPages();

    vi.mocked(tinyglobby.glob).mockRejectedValueOnce(new Error('scan failed'));
    await expect(onChange(join(pagesDir, 'index.md'))).resolves.toBeUndefined();

    expect(plugin.listPages().map((page) => page.path)).toEqual(['/']);
    expect(plugin.logError.mock.calls[0]?.[0]).toContain('scan failed');
  });

  it('fails the invalid page itself, even after the scan has read the same source', async () => {
    const { root, pagesDir } = createApp({ 'index.md': INVALID });
    const plugin = await startPlugin(root, 'serve');
    await plugin.scan();

    const request = () =>
      plugin.transform(INVALID, join(pagesDir, 'index.md').replaceAll('\\', '/'));

    await expect(request()).rejects.toThrow(/pages\/index\.md.*Invalid frontmatter/);
    await expect(request()).rejects.toThrow(/pages\/index\.md.*Invalid frontmatter/);
  });
});

describe('voidMarkdown invalid pages in a build', () => {
  it('fails the build and names the page', async () => {
    const { root } = createApp({ 'broken.md': INVALID, 'other.md': VALID });
    const plugin = await startPlugin(root, 'build');

    await expect(plugin.scan()).rejects.toThrow(/pages\/broken\.md.*Invalid frontmatter/);
    expect(plugin.logError).not.toHaveBeenCalled();
  });

  it('fails the build when a page cannot be read', async () => {
    const { root } = createApp({ 'index.md': VALID });
    const plugin = await startPlugin(root, 'build');

    vi.mocked(tinyglobby.glob).mockResolvedValueOnce(['removed.md']);

    await expect(plugin.scan()).rejects.toThrow(/pages\/removed\.md.*ENOENT/);
  });
});

// The page scan applies the layout and fails on an unknown one, and this package renders the page.
// If they disagree, a page this package rejects can stop the dev server from starting, or a page it
// accepts can get the wrong layout.
describe('the page scan and voidMarkdown', () => {
  it.each([
    ['a plain layout', 'layout: post'],
    ['a layout from a merge key', 'base: &base {layout: post}\n<<: *base'],
    ['tab indentation', 'seo:\n\ttitle: Tab indent\nlayout: post'],
    ['a quoted value across lines', 'title: "Across\nlines"\nlayout: post'],
    ['an empty item', 'tags: [,]\nlayout: post'],
    ['an unclosed sequence', 'layout: [missing'],
    ['an unclosed quote', 'layout: "missing'],
    ['an invalid line', 'title\nlayout: missing'],
    ['an unknown tag on the value', 'layout: !unknown missing'],
    ['an unknown tag on another key', 'other: !unknown value\nlayout: missing'],
    ['a core tag that does not fit the value', 'layout: !!int missing'],
    ['a merge tag', 'other: !!merge value\nlayout: missing'],
    ['a merge key that is not a mapping', '<<: value\nlayout: missing'],
    ['an empty key', ': value\nlayout: missing'],
    ['a control character', 'layout: mis\x01sing'],
  ])('read the same layout from frontmatter with %s', async (_name, frontmatter) => {
    const source = `---\n${frontmatter}\n---\n\n# Hello\n`;
    const { root, pagesDir } = createApp({ 'page.md': source });
    mkdirSync(join(pagesDir, '_layouts'));
    writeFileSync(join(pagesDir, '_layouts', 'post.vue'), '<template><slot /></template>');

    let renderedLayout: unknown;
    try {
      renderedLayout = extractMetadata(source).frontmatter.layout;
    } catch {
      // Rejected, so it has no layout to apply.
    }

    const { pages } = await scanPages(root, { pagesDir });
    expect(pages.find((page) => page.componentId === 'page')?.layout).toBe(renderedLayout);
  });
});
