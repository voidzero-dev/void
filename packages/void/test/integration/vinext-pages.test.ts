import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  spawnFixtureServer,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/vinext-pages';
let DEV_BASE: string;

describe('playground/vinext-pages dev', () => {
  let fixture: IsolatedPlayground;
  let child: ChildProcess;

  beforeAll(async () => {
    fixture = createIsolatedPlayground(ROOT, PLAYGROUND);
    const server = await startServer((port) => {
      child = spawnFixtureServer(fixture.root, 'dev', port);
      return child;
    }, 20_000);
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    fixture?.cleanup();
  });

  it('applies env.ts to server routes', async () => {
    const response = await fetch(`${DEV_BASE}/api/env`);
    expect(await response.json()).toEqual({ SCHEMA_DEFAULT: 48_213 });
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('vinext Pages Router + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });
});
