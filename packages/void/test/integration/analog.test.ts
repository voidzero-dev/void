import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  spawnFixtureServer,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

function removeWranglerConfig(root: string) {
  rmSync(join(root, 'wrangler.jsonc'), { force: true });
  rmSync(join(root, 'wrangler.json'), { force: true });
}

describe('playground/analog dev', () => {
  let fixture: IsolatedPlayground;
  let child: ChildProcess | undefined;
  let DEV_BASE: string;

  beforeAll(async () => {
    fixture = createIsolatedPlayground(ROOT, 'playground/analog');
    // Dev must generate the inferred binding config itself in a fresh fixture.
    rmSync(join(fixture.root, '.void-wrangler.jsonc'), { force: true });
    removeWranglerConfig(fixture.root);

    // Analog skips its Nitro dev server when VITEST or NODE_ENV=test is set, so start
    // the child the way `vp dev` runs for users. Node leaves undefined variables unset.
    // Analog's first dev boot compiles the Angular app. Under a fully parallel test run that can
    // exceed the normal 30s readiness window even though subsequent requests are fast.
    const server = await startServer(
      (port) =>
        (child = spawnFixtureServer(fixture.root, 'dev', port, {
          VITEST: undefined,
          NODE_ENV: undefined,
        })),
      60_000,
    );
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    try {
      if (child) {
        await killChild(child);
      }
    } finally {
      fixture?.cleanup();
    }
  });

  it('syncs the generated Cloudflare config with bindings from void.config.ts', () => {
    const wranglerConfig = parse(
      readFileSync(join(fixture.root, '.void-wrangler.jsonc'), 'utf8'),
    ) as {
      d1_databases?: Array<{ binding: string }>;
      kv_namespaces?: Array<{ binding: string }>;
    };

    expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
    expect(existsSync(join(fixture.root, 'wrangler.jsonc'))).toBe(false);
  });

  it("serves void/db with the app's schema to server routes", async () => {
    const response = await fetch(`${DEV_BASE}/api/smoke`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ firstUser: { name: 'Alice' } });
  });

  it('does not serve the dev-trigger token', async () => {
    const token = readFileSync(join(fixture.root, '.void/dev-trigger-token'), 'utf8').trim();
    // Nitro's dev bundle inlines the trigger dispatch module. Analog builds it before listening.
    expect(existsSync(join(fixture.root, 'dist/.nitro/dev/index.mjs'))).toBe(true);

    for (const path of [
      '/.void/dev-trigger-token',
      '/.void/dev-triggers.ts',
      '/dist/.nitro/dev/index.mjs',
    ]) {
      const response = await fetch(`${DEV_BASE}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain(token);
    }
  });
});
