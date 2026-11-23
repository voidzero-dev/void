import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';

const TMP = packageFixturePath(import.meta.dirname, '__tmp_islands_plugin_image__');
const PAGES_DIR = join(TMP, 'pages');

function writeFile(relativePath: string, content: string): void {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function setupPlugin() {
  const plugins = islandsPlugin(PAGES_DIR);
  const plugin = plugins[0] as unknown as {
    configResolved(config: {
      root: string;
      command: 'build';
      plugins: ReadonlyArray<unknown>;
    }): void;
    buildStart: { call(thisArg: unknown): Promise<void> | void };
    load: { handler(id: string): string | undefined };
  };

  const config = { root: TMP, command: 'build' as const, plugins: [] };
  plugin.configResolved(config);

  return {
    async buildStart() {
      await plugin.buildStart.call({});
    },
    loadRenderer(): string | undefined {
      return plugin.load.handler('\0virtual:void-islands-renderer');
    },
  };
}

describe('islandsPlugin — image preloads', () => {
  beforeEach(() => {
    mkdirSync(PAGES_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('collects preloads per request and puts them into <head>', async () => {
    writeFile('index.island.tsx', `export default function Home() { return <div>Home</div>; }`);

    const { buildStart, loadRenderer } = setupPlugin();
    await buildStart();
    const renderer = loadRenderer() ?? '';
    const serverApp = renderer.slice(renderer.indexOf('function ServerApp() {'));

    expect(renderer).toContain('import { createImagePreloadCollector } from "void/image";');
    expect(renderer).toMatch(/import \{[^}]*\bImagePreloadContext\b[^}]*\} from "@void\/solid";/);
    expect(
      renderer.indexOf('const imagePreloads = createImagePreloadCollector();'),
    ).toBeGreaterThan(renderer.indexOf('export async function renderIslandPage('));
    expect(/createComponent\(([\w.]+)/.exec(serverApp)?.[1]).toBe('ImagePreloadContext.Provider');
    expect(renderer).toContain('<head>${headHtml}${imagePreloads.render()}${assetTags.css}');
  });
});
