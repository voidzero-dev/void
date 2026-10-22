import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { killChild, startServer } from '../../../../test/integration-helpers.ts';
import { GENERATED_ASSET_HEADERS_MARKER } from '../../src/asset-worker-bypass.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_BASE: string;
let PREVIEW_BASE: string;

function clientEntryFile(): string {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'playground/ssr/dist/client/.vite/manifest.json'), 'utf-8'),
  ) as Record<string, { file: string; isEntry?: boolean }>;
  return Object.values(manifest).find((entry) => entry.isEntry)!.file;
}

describe('playground/ssr dev', () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    const server = await startServer((port) => {
      child = spawn(
        'vp',
        [
          'run',
          '--filter',
          './playground/ssr',
          'dev',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            VOID_INSPECTOR_PORT: 'false',
          },
        },
      );
      return child;
    }, 20_000);
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('serves SSR output for / and non-root paths', async () => {
    const rootResponse = await fetch(`${DEV_BASE}/`);
    expect(rootResponse.status).toBe(200);
    const rootHtml = await rootResponse.text();
    expect(rootHtml).toContain('Void SSR Playground');
    expect(rootHtml).toContain('Rendered URL: <!-- -->/');
    expect(rootHtml).toContain('<script type="module" src="/@vite/client"></script>');
    expect(rootHtml).toContain('<script type="module" src="/src/main.client.tsx"></script>');
    expect(rootHtml).toContain('__vite_plugin_react_preamble_installed__ = true');

    const nestedResponse = await fetch(`${DEV_BASE}/dashboard`);
    expect(nestedResponse.status).toBe(200);
    const nestedHtml = await nestedResponse.text();
    expect(nestedHtml).toContain('Rendered URL: <!-- -->/dashboard');

    const clientEntryResponse = await fetch(`${DEV_BASE}/src/main.client.tsx`);
    expect(clientEntryResponse.status).toBe(200);
    const contentType = clientEntryResponse.headers.get('content-type') ?? '';
    expect(contentType).toContain('javascript');
  });
});

describe('playground/ssr build + preview', () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    rmSync(join(ROOT, 'playground/ssr/dist'), { recursive: true, force: true });
    execSync('vp run --filter ./playground/ssr build', { cwd: ROOT, stdio: 'pipe' });

    const server = await startServer((port) => {
      child = spawn(
        'vp',
        [
          'run',
          '--filter',
          './playground/ssr',
          'preview',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            VOID_INSPECTOR_PORT: 'false',
          },
        },
      );
      return child;
    }, 20_000);
    PREVIEW_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('emits worker entry and client manifest', () => {
    const workerEntry = join(ROOT, 'playground/ssr/dist/ssr/index.js');
    const clientManifest = join(ROOT, 'playground/ssr/dist/client/.vite/manifest.json');

    expect(existsSync(workerEntry)).toBe(true);
    expect(existsSync(clientManifest)).toBe(true);

    const code = readFileSync(workerEntry, 'utf-8');
    // String literals survive minification; function names may be mangled
    expect(code).toContain('/.vite/manifest.json');
    expect(code).toContain('src/main.client.tsx');

    const wranglerConfig = JSON.parse(
      readFileSync(join(ROOT, 'playground/ssr/dist/ssr/wrangler.json'), 'utf-8'),
    ) as {
      assets?: {
        not_found_handling?: string;
        run_worker_first?: boolean | Array<string>;
      };
      kv_namespaces?: Array<{ binding: string }>;
    };
    // No middleware or routing rules: Cloudflare serves the hashed bundles itself.
    const runWorkerFirst = wranglerConfig.assets?.run_worker_first as Array<string>;
    expect(runWorkerFirst[0]).toBe('/**');
    expect(runWorkerFirst).toContain(`!/${clientEntryFile()}`);
    expect(wranglerConfig.assets?.not_found_handling).toBe('none');
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);

    const headers = readFileSync(join(ROOT, 'playground/ssr/dist/client/_headers'), 'utf-8');
    expect(headers.split('\n')[0]).toBe(GENERATED_ASSET_HEADERS_MARKER);
    expect(headers).toContain(
      `/${clientEntryFile()}\n  Cache-Control: public, max-age=31536000, immutable\n`,
    );
  });

  it('preview serves the hashed client entry immutable with and without cookies', async () => {
    for (const headers of [{}, { cookie: 'a=b' }] as Array<Record<string, string>>) {
      const response = await fetch(`${PREVIEW_BASE}/${clientEntryFile()}`, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      await response.arrayBuffer();
    }
  });

  it('preview serves SSR pages', async () => {
    const rootFirst = await (await fetch(`${PREVIEW_BASE}/`)).text();
    const rootSecond = await (await fetch(`${PREVIEW_BASE}/`)).text();
    expect(rootFirst).toContain('Rendered URL: <!-- -->/');
    expect(rootSecond).toContain('Rendered URL: <!-- -->/');

    const previewAboutHtml = await (await fetch(`${PREVIEW_BASE}/about`)).text();
    expect(previewAboutHtml).toContain('Rendered URL: <!-- -->/about');
  });
});
