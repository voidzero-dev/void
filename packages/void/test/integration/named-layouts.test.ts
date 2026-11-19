import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  spawnFixtureServer,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_BASE: string;

describe('named-layouts integration', () => {
  let fixture: IsolatedPlayground;
  let child: ChildProcess;

  beforeAll(async () => {
    fixture = createIsolatedPlayground(ROOT, 'playground/named-layouts');
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

  it('/ — default layout chain (root only)', async () => {
    const res = await fetch(`${DEV_BASE}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-page="home"');
  });

  it('/landing — named layout replaces innermost (root replaced by landing)', async () => {
    const res = await fetch(`${DEV_BASE}/landing`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-layout="landing"');
    expect(html).not.toContain('data-layout="root"');
    expect(html).toContain('data-page="landing"');
  });

  it('/bare — layout: false skips all layouts', async () => {
    const res = await fetch(`${DEV_BASE}/bare`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('data-layout=');
    expect(html).toContain('data-page="bare"');
  });

  it('/exclusive — exclusive named layout (!landing), no root', async () => {
    const res = await fetch(`${DEV_BASE}/exclusive`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-layout="landing"');
    expect(html).not.toContain('data-layout="root"');
    expect(html).toContain('data-page="exclusive"');
  });

  it('/docs — index page wrapped by root + docs layout', async () => {
    const res = await fetch(`${DEV_BASE}/docs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-layout="docs"');
    expect(html).toContain('data-page="docs-index"');
  });

  it('/docs/ref — nested named layout replaces docs with api (root + api)', async () => {
    const res = await fetch(`${DEV_BASE}/docs/ref`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('data-layout="api"');
    expect(html).not.toContain('data-layout="docs"');
    expect(html).toContain('data-page="docs-ref"');
  });

  it('/blog/hello — markdown with frontmatter layout: landing (replaces root)', async () => {
    const res = await fetch(`${DEV_BASE}/blog/hello`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Default chain for blog/hello is [root]; landing replaces innermost → root replaced
    expect(html).toContain('data-layout="landing"');
    expect(html).not.toContain('data-layout="root"');
    expect(html).toContain('Hello Blog');
  });

  it('/blog/no-layout — markdown with frontmatter layout: false', async () => {
    const res = await fetch(`${DEV_BASE}/blog/no-layout`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('data-layout=');
    expect(html).toContain('No Layout');
  });
});
