import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';

const repository = join(import.meta.dirname, '..', '..', '..', '..');

describe.each(['node', 'cloudflare'] as const)('trailing-slash Pages on %s', (target) => {
  let fixture: IsolatedPlayground;
  const children: Array<ReturnType<typeof spawn>> = [];
  const servers: Array<{ mode: string; base: string }> = [];
  beforeAll(async () => {
    fixture = createIsolatedPlayground(repository, 'playground/node-app');
    writeFileSync(
      join(fixture.root, 'void.config.ts'),
      renderVoidConfig({
        ...readConfig(fixture.root),
        target,
        output: 'static',
        routing: { trailingSlash: true },
      }),
    );
    for (const [directory, param, value] of [
      ['posts', 'slug', 'hello'],
      ['files', '...path', 'guides/intro'],
    ]) {
      mkdirSync(join(fixture.root, 'pages', directory!), { recursive: true });
      const name = param!.replace('...', '');
      const file = join(fixture.root, 'pages', directory!, `[${param}]`);
      writeFileSync(
        `${file}.tsx`,
        `export default function Page({ value }) { return <h1>{value}</h1>; }`,
      );
      writeFileSync(
        `${file}.server.ts`,
        `export const getPrerenderPaths = () => [{ ${name}: ${JSON.stringify(value)} }];
export const loader = (c) => ({ value: c.req.param(${JSON.stringify(name)}) });`,
      );
    }
    execFileSync('vp', ['build'], { cwd: fixture.root, stdio: 'pipe', timeout: 60_000 });
    for (const mode of ['dev', 'production']) {
      const server = await startServer((port) => {
        const nodeProduction = target === 'node' && mode === 'production';
        const child = spawn(
          nodeProduction ? process.execPath : 'vp',
          nodeProduction
            ? ['dist/ssr/index.js']
            : [
                mode === 'dev' ? 'dev' : 'preview',
                '--host',
                '127.0.0.1',
                '--port',
                String(port),
                '--strictPort',
              ],
          {
            cwd: fixture.root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PORT: String(port) },
          },
        );
        children.push(child);
        return child;
      }, 30_000);
      servers.push({ mode, base: server.base });
    }
  }, 90_000);
  afterAll(async () => {
    for (const child of children) {
      await killChild(child);
    }
    fixture?.cleanup();
  });
  it('builds directory HTML, page-data indexes and a 404 page', () => {
    for (const path of [
      'index.html',
      'about/index.html',
      '_void/pages/about/index.json',
      'posts/hello/index.html',
      'files/guides/intro/index.html',
      '404.html',
    ]) {
      expect(existsSync(join(fixture.root, 'dist/client', path)), path).toBe(true);
    }
    expect(readFileSync(join(fixture.root, 'dist/client/about/index.html'), 'utf8')).toContain(
      'about-title',
    );
  });
  it('redirects to the page URL in dev and production and leaves API routes alone', async () => {
    for (const { base, mode } of servers) {
      const redirect = await fetch(`${base}/about?test=1`, { redirect: 'manual' });
      expect([301, 307, 308], mode).toContain(redirect.status);
      expect(new URL(redirect.headers.get('location')!, base).href, mode).toBe(
        `${base}/about/?test=1`,
      );
      await redirect.text();
      const page = await fetch(`${base}/about/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('about-title');
      for (const [path, value] of [
        ['posts/hello', 'hello'],
        ['files/guides/intro', 'guides/intro'],
      ]) {
        const dynamicRedirect = await fetch(`${base}/${path}`, { redirect: 'manual' });
        expect([301, 307, 308], `${mode}: ${path}`).toContain(dynamicRedirect.status);
        await dynamicRedirect.text();
        const dynamicPage = await fetch(`${base}/${path}/`);
        expect(dynamicPage.status, `${mode}: ${path}`).toBe(200);
        expect(await dynamicPage.text()).toContain(`<h1>${value}</h1>`);
      }
      const api = await fetch(`${base}/api/hello`, { redirect: 'manual' });
      expect(api.status).toBe(200);
      await api.text();
    }
  });
});
