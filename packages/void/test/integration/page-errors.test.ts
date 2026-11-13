import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import { deserializePageData } from '../../src/pages/serialize.ts';

const repository = join(import.meta.dirname, '../../../..');
const frameworks = ['react', 'vue', 'svelte', 'solid'] as const;

describe.each(frameworks)('Pages errors with %s', (framework) => {
  let fixture: IsolatedPlayground;
  let child: ReturnType<typeof spawn>;
  let browser: Browser;
  let base: string;
  const extension = framework === 'vue' ? 'vue' : framework === 'svelte' ? 'svelte' : 'tsx';
  function write(path: string, source: string) {
    const file = join(fixture.root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, source);
  }
  function component(content: string, script = '', layout = false) {
    if (framework === 'vue') {
      return `<script setup>import { Link, useShared, useParams, useRouter } from '@void/vue'; const shared = useShared(); const params = useParams(); defineProps(['error']); ${script}</script><template>${content}${layout ? '<slot />' : ''}</template>`;
    }
    if (framework === 'svelte') {
      return `<script>import { Link, useShared, useParams, useRouter } from '@void/svelte'; let { error, children } = $props(); const shared = useShared(); const params = useParams(); ${script}</script>${content}${layout ? '{@render children?.()}' : ''}`;
    }
    return `import { Link, useShared, useParams, useRouter } from '@void/${framework}'; export default function Component(props) { const shared = useShared(); const params = useParams(); const error = props.error; ${script} return <>${content}${layout ? '{props.children}' : ''}</>; }`;
  }
  beforeAll(async () => {
    fixture = createIsolatedPlayground(
      repository,
      framework === 'react' ? 'playground/node-app' : `playground/${framework}-pages`,
    );
    const nodeServer = join(fixture.root, 'node_modules/@hono/node-server');
    if (!existsSync(nodeServer)) {
      mkdirSync(join(nodeServer, '..'), { recursive: true });
      symlinkSync(
        realpathSync(join(repository, 'playground/node-app/node_modules/@hono/node-server')),
        nodeServer,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    for (const dir of ['pages', 'routes', 'middleware', 'db']) {
      rmSync(join(fixture.root, dir), { recursive: true, force: true });
    }
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'preserve',
        },
      }),
    );
    write(
      'void.config.ts',
      `import { defineConfig } from 'void/config'; export default defineConfig({target:'node'});`,
    );
    write(
      'middleware/shared.ts',
      `import { defineMiddleware } from 'void/handler'; export default defineMiddleware(async (c,next)=>{c.set('shared',{viewer:'alice',...(c.req.header('X-Test-No-Root') ? { noRoot: true } : {})}); c.header('X-Security','retained'); const guard=c.req.header('X-Test-Guard'); if(guard==='not-found') return c.notFound(); if(guard==='explicit') return c.text('Hidden by guard',404); await next(); if(guard==='after-not-found') c.res=await c.notFound();});`,
    );
    write('pages/style.css', 'nav { color: rgb(20, 80, 100); }');
    write(
      'middleware/status.ts',
      `import { defineMiddleware } from 'void/handler';
import { HTTPException } from 'hono/http-exception';
export default defineMiddleware(async (c, next) => {
  const status = c.req.header('X-Test-Error-Status');
  if (status === '403' || status === '503') {
    c.header('Retry-After', '120');
    throw new HTTPException(status === '403' ? 403 : 503, {
      message: status === '403' ? 'Your account is banned' : 'Down for maintenance',
    });
  }
  await next();
});`,
    );
    const nav =
      '<nav data-layout="root"><Link href="/">Home</Link><Link href="/items/returned">Returned</Link><Link href="/items/thrown">Thrown</Link><Link href="/items/unexpected">Unexpected</Link><Link href="/crash">Crash</Link><Link href="/nested/crash">Nested</Link><Link href="/nested/deep/crash">Deep</Link><Link href="/nested/layout">Layout</Link><Link href="/client-only">Client only</Link></nav>';
    let rootLayout = component(nav, '', true);
    if (framework === 'vue' || framework === 'svelte') {
      rootLayout = rootLayout

        .replace('import { Link,', "import './style.css'; import { Link,");
    } else {
      rootLayout = `import './style.css'; ${rootLayout}`;
    }
    write(`pages/layout.${extension}`, rootLayout);
    write(
      `pages/index.${extension}`,
      component(
        '<h1>Home page</h1>',
        "const router = useRouter(); if(typeof window!=='undefined') window.testRouter=router;",
      ),
    );
    write(
      `pages/_not-found.${extension}`,
      component(
        '<h1>Missing page</h1><p>{error.message}</p>',
        "if(shared.noRoot) throw new Error('UNUSED_ROOT_BOUNDARY');",
      ),
    );
    write(`pages/_error.${extension}`, component('<h1>Error page</h1><p>{error.message}</p>'));
    if (framework === 'vue') {
      write(
        `pages/_not-found.${extension}`,
        component(
          '<h1>Missing page</h1><p>{{error.message}}</p>',
          "if(shared.noRoot) throw new Error('UNUSED_ROOT_BOUNDARY');",
        ),
      );
      write(`pages/_error.${extension}`, component('<h1>Error page</h1><p>{{error.message}}</p>'));
    }
    write(`pages/items/[id].${extension}`, component('<h1>Item</h1>'));
    write(`pages/status/[code].${extension}`, component('<h1>Status page</h1>'));
    write(
      'pages/status/[code].server.ts',
      `import { defineHandler } from 'void/handler';
export const loader = defineHandler(c => {
  c.status(c.req.param('code') === '403' ? 403 : 503);
  c.header('Retry-After', '120');
  return {};
});`,
    );
    for (const name of ['falsy', 'island-falsy.island']) {
      write(`pages/${name}.${extension}`, component('<h1>Broken view</h1>', 'throw undefined;'));
    }
    write(
      'pages/items/[id].server.ts',
      `import { defineHandler } from 'void/handler'; import { HTTPException } from 'hono/http-exception'; export const loader = defineHandler(c=>{const id=c.req.param('id'); if(id==='returned') return c.notFound(); if(id==='thrown') throw new HTTPException(404,{message:'Deleted item'}); if(id==='unexpected') throw Object.assign(new Error('SECRET_SERVER_MARKER'),{secret:'SECRET_CUSTOM_MARKER'}); return {};});`,
    );
    write(
      `pages/crash.${extension}`,
      component(
        '<h1>Crash route</h1>',
        `if(typeof window!=='undefined') throw new Error('SECRET_CLIENT_MARKER');`,
      ),
    );
    write(
      `pages/nested/layout.${extension}`,
      component(
        '<section data-layout="nested"></section>',
        "if(params.kind==='layout') throw new Error('SECRET_LAYOUT_MARKER');",
        true,
      ),
    );
    write(`pages/nested/_error.${extension}`, component('<h1>Nested error</h1>'));
    write(
      `pages/nested/deep/_error.${extension}`,
      component('<h1>Broken fallback</h1>', "throw new Error('SECRET_FALLBACK_MARKER');"),
    );
    for (const prefix of ['nested', 'nested/deep']) {
      write(
        `pages/${prefix}/[kind].${extension}`,
        component(
          '<h1>Nested route</h1>',
          "if(params.kind==='server'||(params.kind!=='healthy'&&typeof window!=='undefined')) throw new Error('SECRET_RENDER_MARKER');",
        ),
      );
    }
    write(
      `pages/client-only.${extension}`,
      component(
        '<h1>Client only</h1>',
        "if(typeof window==='undefined') throw new Error('SECRET_SSR_DISABLED');",
      ),
    );
    write(
      'pages/client-only.server.ts',
      'export const ssr = false; export const loader = () => new Response(null,{status:404});',
    );
    write(
      `pages/retry.${extension}`,
      component(
        '<h1>Recovered page</h1>',
        "if(typeof window!=='undefined'&&!window.recovered) throw new Error('SECRET_RETRY');",
      ),
    );
    write(
      `pages/fatal/[kind].${extension}`,
      component(
        '<h1>Fatal route</h1>',
        "if(typeof window!=='undefined') throw new Error('SECRET_FATAL');",
      ),
    );
    write(
      'routes/old-terminal.ts',
      "export default (c) => c.redirect('/fatal/terminal?from=old');",
    );
    write(
      `pages/_error.${extension}`,
      component(
        framework === 'vue'
          ? '<h1>Error page</h1><p>{{error.message}}</p>'
          : '<h1>Error page</h1><p>{error.message}</p>',
        "if(params.kind==='terminal') throw new Error('SECRET_TERMINAL');",
      ),
    );
    write(`pages/nested/other.${extension}`, component('<h1>Other nested page</h1>'));
    write(`pages/islands/index.island.${extension}`, component('<h1>Island document</h1>'));
    write('pages/islands/index.server.ts', 'export const loader = c => c.notFound();');
    write(`pages/islands/_not-found.${extension}`, component('<h1>Missing island page</h1>'));
    const counter =
      framework === 'react'
        ? "import {useState} from 'react'; export default function Counter(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count: {n}</button>}"
        : framework === 'solid'
          ? "import {createSignal} from 'solid-js'; export default function Counter(){const [n,setN]=createSignal(0);return <button onClick={()=>setN(n()+1)}>Count: {n()}</button>}"
          : framework === 'vue'
            ? '<script setup>import {ref} from "vue"; const n=ref(0);</script><template><button @click="n++">Count: {{n}}</button></template>'
            : '<script>let n=$state(0);</script><button onclick={()=>n++}>Count: {n}</button>';
    write(`pages/islands/_Counter.${extension}`, counter);
    let islandLayout = component('<Counter />', '', true);
    const counterImport = `import Counter from './_Counter.${extension}' with {island:'load'};`;
    islandLayout =
      framework === 'vue' || framework === 'svelte'
        ? islandLayout.replace('import { Link,', counterImport + '\n import { Link,')
        : counterImport + islandLayout;
    write(`pages/islands/layout.island.${extension}`, islandLayout);
    for (const section of ['alpha', 'beta']) {
      write(
        `pages/${section}/index.${extension}`,
        component(
          '<h1>Section page</h1>',
          "if(typeof window!=='undefined') throw new Error('SECRET_SECTION');",
        ),
      );
      write(`pages/${section}/_error.${extension}`, component(`<h1>${section} error</h1>`));
    }
    write(`pages/hmr/index.${extension}`, component('<h1>HMR route</h1>'));
    write(
      'pages/hmr/index.server.ts',
      'export const loader = () => new Response(null,{status:404});',
    );
    write('routes/api/missing.ts', `export const GET = c => c.text('API missing',404);`);
    execFileSync('vp', ['build'], {
      cwd: fixture.root,
      stdio: 'pipe',
      timeout: 60_000,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const server = await startServer(
      (port) =>
        (child = spawn(process.execPath, ['dist/ssr/index.js'], {
          cwd: fixture.root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PORT: String(port) },
        })),
      30_000,
    );
    base = server.base;
    browser = await launchPagesBrowser();
  }, 90_000);
  afterAll(async () => {
    await browser?.close();
    if (child) {
      await killChild(child);
    }
    fixture?.cleanup();
  });
  it.each(['not-found', 'after-not-found'])(
    'uses the root not-found for middleware guards (%s) and preserves explicit responses',
    async (guard) => {
      for (const pages of [false, true]) {
        const headers = {
          'X-Test-Guard': guard,
          ...(pages && { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION }),
        };
        const response = await fetch(base + '/islands', { headers });
        expect(response.status).toBe(404);
        expect(response.headers.get('X-Security')).toBe('retained');
        const body = await response.text();
        if (pages) {
          expect(response.headers.get('X-VoidPages')).toBe('true');
          const data = deserializePageData<{ component: string }>(body);
          expect(data.component).toContain('_void:boundary:root-not-found:');
          expect(data).toMatchObject({
            props: { error: { status: 404, message: 'Not Found' } },
            shared: { viewer: 'alice' },
          });
        } else {
          expect(body).toContain('Missing page');
          expect(body).toContain('data-layout="root"');
          expect(body).not.toContain('Missing island page');
        }
        const explicit = await fetch(base + '/islands', {
          headers: { ...headers, 'X-Test-Guard': 'explicit' },
        });
        expect(explicit.status).toBe(404);
        expect(explicit.headers.has('X-VoidPages')).toBe(false);
        expect(await explicit.text()).toBe('Hidden by guard');
      }
    },
  );

  it('renders a loader not-found without attempting an unused root boundary', async () => {
    const response = await fetch(base + '/islands', { headers: { 'X-Test-No-Root': 'true' } });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Missing island page');
  });

  it.each(
    ([403, 503] as const).flatMap((status) =>
      (['HTML', 'Pages JSON'] as const).map((format) => ({ status, format })),
    ),
  )(
    'renders middleware errors through the root page boundary with HTTP $status ($format)',
    async ({ status, format }) => {
      const message = status === 403 ? 'Your account is banned' : 'Down for maintenance';
      // This route throws a different error if its loader is reached.
      const response = await fetch(base + '/items/unexpected', {
        headers: {
          'X-Test-Error-Status': String(status),
          ...(format === 'Pages JSON'
            ? { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION }
            : { Accept: 'text/html' }),
        },
      });
      const body = await response.text();
      expect(response.status).toBe(status);
      expect(body).not.toContain('SECRET_');
      if (format === 'Pages JSON') {
        expect(response.headers.get('X-VoidPages')).toBe('true');
        expect(deserializePageData(body)).toMatchObject({
          props: { error: { status, message } },
          shared: { viewer: 'alice' },
          url: '/items/unexpected',
        });
      } else {
        expect(response.headers.get('Content-Type')).toContain('text/html');
        expect(body).toContain('Error page');
        expect(body).toContain(message);
        expect(body).toContain('data-layout="root"');
        expect(body).toContain('stylesheet');
      }
      expect(response.headers.get('Retry-After')).toBe('120');
      expect(response.headers.get('X-Security')).toBe('retained');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    },
  );

  it('returns status-correct documents and marked error payloads without exposing secrets', async () => {
    for (const [path, status] of [
      ['/unknown', 404],
      ['/items/returned', 404],
      ['/items/thrown', 404],
      ['/items/unexpected', 500],
    ] as const) {
      for (const pages of [false, true]) {
        const response = await fetch(base + path, {
          headers: pages
            ? { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION }
            : { Accept: 'text/html' },
        });
        expect(response.status, path).toBe(status);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('X-Security')).toBe('retained');
        const text = await response.text();
        expect(text).not.toContain('SECRET_');
        if (pages) {
          expect(response.headers.get('X-VoidPages')).toBe('true');
          expect(deserializePageData(text)).toMatchObject({
            url: path,
            shared: { viewer: 'alice' },
            props: { error: { status } },
          });
        } else {
          expect(text).toContain('data-layout="root"');
        }
      }
    }
    for (const path of [
      '/nested/server',
      '/nested/deep/server',
      '/nested/layout',
      '/falsy',
      '/island-falsy',
    ]) {
      const document = await fetch(base + path);
      expect(document.status, path).toBe(500);
      const html = await document.text();
      expect(html).toContain(
        path.endsWith('/layout') || path.includes('falsy') ? 'Error page' : 'Nested error',
      );
      expect(html).not.toContain('SECRET_');
    }
    const response = await fetch(base + '/api/missing');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('API missing');
  });
  it('renders application-defined error statuses on document loads and client visits', async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    try {
      for (const status of [403, 503]) {
        const path = `/status/${status}`;
        const documentResponse = await fetch(base + path);
        expect(documentResponse.status).toBe(status);
        expect(documentResponse.headers.get('Retry-After')).toBe('120');
        expect(await documentResponse.text()).toContain('Status page');

        await page.goto(base);
        await page.waitForSelector('#app[data-hydrated="true"]');
        await page.evaluate(() =>
          document.querySelector('nav')!.setAttribute('data-retained', 'yes'),
        );
        const navigation = page.waitForResponse(
          (response) =>
            response.url() === base + path &&
            response.request().headers()['x-voidpages'] === 'true',
        );
        await page.evaluate(`window.testRouter.visit(${JSON.stringify(path)})`);
        const response = await navigation;
        expect(response.status()).toBe(status);
        expect(response.headers()['x-voidpages']).toBe('true');
        await expect.poll(() => page.locator('h1').textContent()).toBe('Status page');
        expect(await page.locator('nav').getAttribute('data-retained')).toBe('yes');
      }
    } finally {
      await page.close();
    }
  });

  it('keeps the app and outer layout mounted across 404s and client errors', async () => {
    const page = await browser.newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') {
        errors.push(m.text());
      }
    });
    page.setDefaultTimeout(8_000);
    try {
      await page.goto(base);
      await page.waitForSelector('#app[data-hydrated="true"]');
      await page.evaluate(() => {
        (window as unknown as { marker: boolean }).marker = true;
        document.querySelector('nav')!.setAttribute('data-retained', 'yes');
      });
      for (const name of ['Returned', 'Thrown', 'Unexpected', 'Crash']) {
        await page.getByRole('link', { name, exact: true }).click();
        await expect
          .poll(() => page.locator('h1').textContent())
          .toBe(name === 'Returned' || name === 'Thrown' ? 'Missing page' : 'Error page');
        expect(await page.evaluate(() => (window as unknown as { marker: boolean }).marker)).toBe(
          true,
        );
        expect(await page.locator('nav').getAttribute('data-retained')).toBe('yes');
        expect(await page.locator('body').textContent()).not.toContain('SECRET_');
      }
    } catch (error) {
      console.error(framework, page.url(), errors);
      throw error;
    } finally {
      await page.close();
    }
  });
  it('escalates failed fallbacks and layouts while retaining healthy ancestors', async () => {
    const page = await browser.newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') {
        errors.push(m.text());
      }
    });
    page.setDefaultTimeout(8_000);
    try {
      await page.goto(base);
      await page.waitForSelector('#app[data-hydrated="true"]');
      await page.evaluate(() =>
        document.querySelector('nav')!.setAttribute('data-retained', 'yes'),
      );
      for (const [link, expected] of [
        ['Nested', 'Nested error'],
        ['Deep', 'Nested error'],
        ['Layout', 'Error page'],
        ['Client only', 'Missing page'],
      ]) {
        await page.getByRole('link', { name: link, exact: true }).click();
        await expect.poll(() => page.locator('h1').textContent()).toBe(expected);
        expect(await page.locator('nav').getAttribute('data-retained')).toBe('yes');
        expect(await page.locator('body').textContent()).not.toContain('SECRET_');
        await page.getByRole('link', { name: 'Home', exact: true }).click();
        await expect.poll(() => page.locator('h1').textContent()).toBe('Home page');
      }
      await page.goto(base + '/nested/deep/server');
      await page.waitForSelector('#app[data-hydrated="true"]');
      expect(await page.locator('h1').textContent()).toBe('Nested error');
      expect(await page.locator('body').textContent()).not.toContain('SECRET_');
    } catch (error) {
      console.error(framework, page.url(), errors);
      throw error;
    } finally {
      await page.close();
    }
  });

  it('refreshes a failed client page, preserves a common nested layout, and settles terminal navigation', async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    try {
      await page.goto(base);
      await page.waitForSelector('#app[data-hydrated="true"]');
      const visit = (url: string) =>
        page.evaluate(
          `window.testRouter.visit(${JSON.stringify(url)}).then(() => 'resolved', () => 'rejected')`,
        );
      await visit('/retry');
      await expect.poll(() => page.locator('h1').textContent()).toBe('Error page');
      await page.evaluate('window.recovered=true; window.testRouter.refresh()');
      await expect.poll(() => page.locator('h1').textContent()).toBe('Recovered page');
      for (const section of ['alpha', 'beta']) {
        await visit('/' + section);
        await expect.poll(() => page.locator('h1').textContent()).toBe(section + ' error');
      }
      await visit('/nested/healthy');
      await page
        .locator('section[data-layout="nested"]')
        .evaluate((el) => el.setAttribute('data-retained', 'yes'));
      await visit('/nested/other');
      expect(
        await page.locator('section[data-layout="nested"]').getAttribute('data-retained'),
      ).toBe('yes');
      await visit('/old-terminal');
      await expect.poll(() => page.locator('h1').textContent()).toBe('Something went wrong');
      expect(new URL(page.url()).pathname).toBe('/fatal/terminal');
      expect(new URL(page.url()).search).toBe('?from=old');
      expect(
        await page.getByRole('link', { name: 'Try again', exact: true }).getAttribute('href'),
      ).toBe(base + '/fatal/terminal?from=old');
    } finally {
      await page.close();
    }
  });
  it('hydrates retained layout islands in a server-only boundary document', async () => {
    const response = await fetch(base + '/islands');
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('Missing island page');
    expect(html).not.toContain('__VOID_PAGE_DATA__');
    const page = await browser.newPage();
    try {
      await page.goto(base + '/islands');
      await page.waitForSelector('[data-island][data-hydrated="true"]');
      await page.getByRole('button', { name: 'Count: 0', exact: true }).click();
      await expect.poll(() => page.getByRole('button').textContent()).toBe('Count: 1');
    } finally {
      await page.close();
    }
  });

  it('refreshes boundary metadata when files are added and removed during development', async () => {
    await killChild(child);
    write('public/download', 'Download bytes');
    const dev = await startServer(
      (port) =>
        (child = spawn(
          'vp',
          ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
          {
            cwd: fixture.root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_ENV: 'development' },
          },
        )),
      30_000,
    );
    try {
      const download = await fetch(dev.base + '/download');
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('Download bytes');
      const missing = await fetch(dev.base + '/hmr');
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain('Missing page');
      const file = `pages/hmr/_not-found.${extension}`;
      write(file, component('<h1>HMR missing page</h1>'));
      await expect
        .poll(async () => (await fetch(dev.base + '/hmr')).text(), { timeout: 10_000 })
        .toContain('HMR missing page');
      rmSync(join(fixture.root, file));
      await expect
        .poll(async () => (await fetch(dev.base + '/hmr')).text(), { timeout: 10_000 })
        .not.toContain('HMR missing page');
      const updated = await fetch(dev.base + '/hmr');
      expect(updated.status).toBe(404);
      expect(await updated.text()).toContain('Missing page');
    } finally {
      await killChild(child);
      rmSync(join(fixture.root, 'public/download'));
    }

    write('public/404.html', '<h1>Static fallback</h1>');
    write(
      'void.config.ts',
      "import { defineConfig } from 'void/config'; export default defineConfig({target:'node',routing:{trailingSlash:true}});",
    );
    const trailing = await startServer(
      (port) =>
        (child = spawn(
          'vp',
          ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
          {
            cwd: fixture.root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_ENV: 'development' },
          },
        )),
      30_000,
    );
    const page = await browser.newPage();
    try {
      const module = await fetch(trailing.base + '/pages/index.' + extension);
      expect(module.status).toBe(200);
      expect(await module.text()).not.toContain('Static fallback');
      await page.goto(trailing.base);
      await page.waitForSelector('#app[data-hydrated="true"]');
      await page.getByRole('link', { name: 'Returned', exact: true }).click();
      await expect.poll(() => page.locator('h1').textContent()).toBe('Missing page');
    } finally {
      await page.close();
      await killChild(child);
      rmSync(join(fixture.root, 'public/404.html'));
    }
  });
  it('generates a server-only static 404 without request middleware or hydration data', async () => {
    await killChild(child);
    for (const path of [
      'pages/hmr',
      'pages/alpha',
      'pages/beta',
      'pages/fatal',
      'pages/retry.' + extension,
      'pages/islands',
      'pages/nested',
      'pages/crash.' + extension,
      'pages/client-only.' + extension,
      'pages/client-only.server.ts',
      'pages/items',
      'pages/falsy.' + extension,
      'pages/island-falsy.island.' + extension,
    ]) {
      rmSync(join(fixture.root, path), { recursive: true, force: true });
    }
    write(
      'void.config.ts',
      "import { defineConfig } from 'void/config'; export default defineConfig({target:'node',output:'static'});",
    );
    execFileSync('vp', ['build'], {
      cwd: fixture.root,
      stdio: 'pipe',
      timeout: 60_000,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const html = readFileSync(join(fixture.root, 'dist/client/404.html'), 'utf8');
    expect(html).toContain('Missing page');
    expect(html).toContain('data-layout="root"');
    expect(html).toContain('stylesheet');
    expect(html).not.toContain('__VOID_PAGE_DATA__');
    expect(html).not.toContain('type="module"');
    expect(html).not.toContain('alice');
    expect(existsSync(join(fixture.root, 'dist/client/_void/pages/404.json'))).toBe(false);
    if (framework === 'react') {
      rmSync(join(fixture.root, 'pages/index.tsx'));
      write(
        'void.config.ts',
        "import { defineConfig } from 'void/config'; export default defineConfig({target:'cloudflare',output:'static'});",
      );
      execFileSync('vp', ['build'], {
        cwd: fixture.root,
        stdio: 'pipe',
        timeout: 60_000,
        env: { ...process.env, NODE_ENV: 'production' },
      });
      const native404 = readFileSync(join(fixture.root, 'dist/client/404.html'), 'utf8');
      expect(native404).toContain('Missing page');
      expect(native404).not.toContain('__VOID_PAGE_DATA__');
      expect(native404).not.toContain('type="module"');
    }
  });
});
