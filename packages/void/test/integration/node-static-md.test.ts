import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';
import type { IsolatedPlayground } from '../../../../test/integration-helpers.ts';

// A Markdown-only pages app still needs a client build: its closeBundle
// prerenders. Markdown pages are implicit islands, so the client input comes
// from the islands plugin; without it the build fails with UNRESOLVED_ENTRY.
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/node-static-md';
let fixture: IsolatedPlayground;
let DIST: string;

describe('playground/node-static-md build (Markdown-only, target: node, output: static)', () => {
  beforeAll(() => {
    fixture = createIsolatedPlayground(ROOT, PLAYGROUND);
    DIST = join(fixture.root, 'dist');
    execFileSync('vp', ['run', 'build'], { cwd: fixture.root, stdio: 'pipe' });
  });

  afterAll(() => {
    fixture?.cleanup();
  });

  it('emits the Node SSR entry', () => {
    expect(existsSync(join(DIST, 'ssr/app.js'))).toBe(true);
  });

  it('prerenders Markdown pages to HTML', () => {
    const index = join(DIST, 'client/index.html');
    const post = join(DIST, 'client/posts/hello.html');
    expect(existsSync(index)).toBe(true);
    expect(existsSync(post)).toBe(true);

    const postHtml = readFileSync(post, 'utf8');
    expect(postHtml).toContain('<!doctype html>');
    // The Markdown body and its syntax-highlighted code block were rendered.
    expect(postHtml).toContain('Hello');
    expect(postHtml).toContain('shiki');
  });

  it('keeps prerendered Markdown pages free of client JS bundles', () => {
    const postHtml = readFileSync(join(DIST, 'client/posts/hello.html'), 'utf8');
    // No framework hydration/entry bundle is referenced by a zero-JS page.
    expect(postHtml).not.toContain('type="module"');
    expect(postHtml).not.toContain('src="/assets/');
  });
});
