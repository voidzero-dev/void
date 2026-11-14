import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { killChild, startServer } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/tanstack-start';
let DEV_BASE: string;

describe('playground/tanstack-start dev', () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    // Another process can answer on the port before this server starts,
    // so only this app's page counts as ready.
    const server = await startServer(
      (port) => {
        child = spawn(
          'vp',
          [
            'run',
            '--filter',
            `./${PLAYGROUND}`,
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
      },
      20_000,
      { expectBody: 'TanStack Start + Void' },
    );
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('applies env.ts to server routes', async () => {
    const response = await fetch(`${DEV_BASE}/api/env`);
    expect(await response.json()).toEqual({ SCHEMA_DEFAULT: 48213 });
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('TanStack Start + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });
});
