import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
} from '../../../../test/integration-helpers.ts';

const repository = join(import.meta.dirname, '../../../..');

describe('built-in JSX Pages', () => {
  it('keeps an adapter active and rejects an aliased React hook only when the server component calls it', async () => {
    const fixture = createIsolatedPlayground(repository, 'playground/node-app');
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      writeFileSync(
        join(fixture.root, 'shared-button.tsx'),
        `
        import React, { useState as reactState } from 'react';
        export function Button({ useHook = false }: { useHook?: boolean }) {
          const label = useHook ? reactState('React state')[0] : 'Shared button';
          return <button>{label}</button>;
        }
      `,
      );
      writeFileSync(
        join(fixture.root, 'pages/about.tsx'),
        `
        import { Button } from '../shared-button.tsx';
        export default function About() { return <Button useHook />; }
      `,
      );
      writeFileSync(
        join(fixture.root, 'pages/native.server.tsx'),
        `
        import { defineHandler, type InferProps } from 'void';
        import { Button } from '../shared-button.tsx';
        export const loader = defineHandler((c) => ({ useHook: c.req.query('hook') === '1' }));
        export default function Page(props: InferProps<typeof loader>) {
          return <Button {...props} />;
        }
      `,
      );
      server = await startServer(
        (port) =>
          spawn('vp', ['dev', '--strictPort', '--port', String(port)], {
            cwd: fixture.root,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        20_000,
      );
      const adapter = await fetch(`${server.base}/about`);
      expect(await adapter.text()).toContain('React state');
      const native = await fetch(`${server.base}/native`);
      expect(await native.text()).toContain('<button>Shared button</button>');
      const invalid = await fetch(`${server.base}/native?hook=1`);
      expect(invalid.status).toBe(500);
      expect(await invalid.text()).toContain('cannot call react.useState()');
    } finally {
      if (server) {
        await killChild(server.child);
      }
      fixture.cleanup();
    }
  }, 30_000);

  it.each([
    ['Cloudflare', 'dev'],
    ['Cloudflare', 'preview'],
    ['Node', 'dev'],
    ['Node', 'preview'],
  ])(
    'renders HTML and CSS on %s in %s without JavaScript',
    async (target, command) => {
      const fixture = createIsolatedPlayground(repository, 'playground/server-components');
      let server: Awaited<ReturnType<typeof startServer>> | undefined;
      try {
        writeFileSync(
          join(fixture.root, 'pages/empty-loader.server.tsx'),
          `
          export const loader = () => ({});
          export default function Page(props) {
            return <h1>{'req' in props ? 'Received context' : 'Received empty props'}</h1>;
          }
          `,
        );
        const weatherPage = join(fixture.root, 'pages/weather.server.tsx');
        const weatherData = (temperature: number) =>
          'data:application/json,' +
          encodeURIComponent(JSON.stringify({ current: { temperature_2m: temperature } }));
        writeFileSync(
          weatherPage,
          readFileSync(weatherPage, 'utf8').replace(
            'fetch(forecastUrl,',
            `fetch(forecastUrl.searchParams.get('latitude') === '1.29' &&
              forecastUrl.searchParams.get('longitude') === '103.85'
                ? '${weatherData(29)}'
                : '${weatherData(12)}',`,
          ),
        );
        if (target === 'Node') {
          writeFileSync(join(fixture.root, 'void.config.ts'), `export default { target: 'node' };`);
        }
        if (command === 'preview') {
          execFileSync('vp', ['build'], { cwd: fixture.root, stdio: 'pipe' });
        }
        server = await startServer(
          (port) =>
            target === 'Node' && command === 'preview'
              ? spawn(process.execPath, ['dist/ssr/index.js'], {
                  cwd: fixture.root,
                  stdio: ['ignore', 'pipe', 'pipe'],
                  env: { ...process.env, PORT: String(port) },
                })
              : spawn(
                  'vp',
                  [
                    command,
                    ...(command === 'dev' ? ['--force'] : []),
                    '--strictPort',
                    '--port',
                    String(port),
                  ],
                  { cwd: fixture.root, stdio: ['ignore', 'pipe', 'pipe'] },
                ),
          20_000,
        );
        const base = server.base;
        const [home, escapedGreeting, asyncContext, about, post, missing] = await Promise.all([
          fetch(base, { headers: { 'X-VoidPages': 'true' } }),
          fetch(`${base}/greeting?name=%3Cscript%3E`),
          fetch(`${base}/async-context?greeting=Welcome`),
          fetch(`${base}/about`),
          fetch(`${base}/posts/42`),
          fetch(`${base}/missing`),
        ]);
        expect(home.headers.get('content-type')).toContain('text/html');
        expect(home.headers.has('x-voidpages')).toBe(false);
        const document = await home.text();
        expect(document).toContain('<h1>Server Component Examples</h1>');
        expect(await asyncContext.text()).toContain('Welcome, reader!');
        const githubSource =
          'https://github.com/voidzero-dev/void/blob/server-components/playground/server-components/';
        const sourceBase =
          command === 'dev'
            ? `vscode://file${new URL('file://' + fixture.root + '/').pathname}`
            : githubSource;
        expect(document).toContain(`${sourceBase}pages/posts/%5Bid%5D/index.server.tsx`);
        expect(document).not.toContain(command === 'dev' ? githubSource : 'vscode://file');
        expect(document).not.toContain('<script');
        expect(await escapedGreeting.text()).toContain('Hello, &lt;script&gt;!');
        const emptyLoader = await fetch(`${base}/empty-loader`);
        expect(emptyLoader.status).toBe(200);
        expect(await emptyLoader.text()).toContain('<h1>Received empty props</h1>');
        const aboutDocument = await about.text();
        expect(aboutDocument).toContain('<title>About | Server Components</title>');
        expect(aboutDocument).toContain('About this playground');
        expect(aboutDocument).not.toContain('Main navigation');
        const postDocument = await post.text();
        expect(postDocument).toContain('<title>Post 42</title>');
        expect(postDocument).toContain('<h1>Post 42</h1>');
        expect(postDocument).toContain(
          '<meta name="description" content="A post whose title and description resolve before rendering."',
        );
        expect(postDocument).not.toContain('<script');
        expect(postDocument).toContain('Main navigation');
        expect(postDocument).toContain('Nested posts layout');
        const redirect = await fetch(`${base}/posts/latest`, { redirect: 'manual' });
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get('location')).toBe('/posts/42');
        expect(missing.status).toBe(404);
        const notFound = await missing.text();
        expect(notFound).toContain('Page not found');
        expect(notFound).toContain('Main navigation');
        const missingPost = await fetch(`${base}/posts/missing`);
        expect(missingPost.status).toBe(404);
        const postNotFound = await missingPost.text();
        expect(postNotFound).toContain('Post not found');
        expect(postNotFound).toContain('Main navigation');
        expect(postNotFound).toContain('Nested posts layout');
        const nested = await (await fetch(`${base}/posts`)).text();
        expect(nested).toContain('Main navigation');
        expect(nested).toContain('Nested posts layout');
        const replacement = await (await fetch(`${base}/posts/layout-example`)).text();
        expect(replacement).toContain('Main navigation');
        expect(replacement).toContain('Post layout');
        expect(replacement).not.toContain('Nested posts layout');
        const exclusive = await (await fetch(`${base}/exclusive-layout`)).text();
        expect(exclusive).toContain('Replace the whole layout chain');
        expect(exclusive).toContain('Post layout');
        expect(exclusive).not.toContain('Main navigation');

        for (const [html, source] of [
          [await (await fetch(`${base}/weather`)).text(), 'pages/weather.server.tsx'],
          [aboutDocument, 'pages/about.server.tsx'],
          [postDocument, 'pages/posts/%5Bid%5D/index.server.tsx'],
          [notFound, 'pages/_not-found.server.tsx'],
          [postNotFound, 'pages/posts/_not-found.server.tsx'],
          [replacement, 'pages/posts/layout-example.server.tsx'],
          [exclusive, 'pages/exclusive-layout.server.tsx'],
        ]) {
          expect(html).toContain(`href="${sourceBase}${source}"`);
        }

        const browser = await chromium.launch();
        try {
          const page = await browser.newPage({ javaScriptEnabled: false });
          await page.goto(base);
          const nav = page.getByRole('navigation');
          expect(await nav.getByRole('link').allTextContents()).toEqual([
            'Server Component Examples',
          ]);
          expect(await nav.getByRole('link').getAttribute('href')).toBe('/');
          const grids = await page.locator('.examples').all();
          expect(grids).toHaveLength(3);
          for (const grid of grids) {
            expect(await grid.evaluate((element) => getComputedStyle(element).display)).toBe(
              'grid',
            );
          }
          const cards = await page.locator('.example').all();
          expect(cards).toHaveLength(14);
          expect((await page.locator('.example h3').allTextContents()).slice(1, 3)).toEqual([
            'Async component fetches weather',
            'Render a page with a loader',
          ]);
          for (const card of cards) {
            expect(await card.getByRole('heading').count()).toBe(1);
            expect(await card.locator('.source-link').getAttribute('href')).toMatch(
              command === 'dev' ? /^vscode:\/\/file/ : /^https:\/\/github\.com\//,
            );
            expect(
              await card.getByRole('link', { name: 'See example' }).getAttribute('href'),
            ).toMatch(/^\/.+/);
          }
          await page
            .locator('.example')
            .filter({ hasText: 'Render a page with a loader' })
            .getByRole('link', { name: 'See example' })
            .click();
          await page.getByLabel('Name').fill('playground reader');
          await page.getByRole('button', { name: 'Update greeting' }).click();
          await page.getByText('Hello, playground reader!').waitFor();
          await page.goto(`${base}/custom-layout`);
          await page.getByRole('heading', { name: 'Use a custom layout' }).waitFor();
          await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
          await page.getByText('Current path: /custom-layout').waitFor();
          await page.getByText('End of the field guide').waitFor();
          expect(
            await page
              .getByRole('link', { name: 'pages/custom-layout/layout.server.tsx' })
              .getAttribute('href'),
          ).toBe(`${sourceBase}pages/custom-layout/layout.server.tsx`);
          await page.goto(`${base}/css`);
          expect(await page.getByRole('navigation').count()).toBe(0);
          expect(
            await page.locator('.examples').evaluate((grid) => getComputedStyle(grid).display),
          ).toBe('grid');
          await page.goto(`${base}/weather`);
          await page.getByText('Temperature: 29 °C').waitFor();
          await page.getByRole('heading', { name: 'Current weather in Singapore' }).waitFor();
          const location = page.getByLabel('Location');
          expect(await location.locator('option').allTextContents()).toEqual([
            'Singapore',
            'Austin',
            'Lisbon',
            'London',
            'San Francisco',
          ]);
          expect(await location.inputValue()).toBe('singapore');
          await location.selectOption({ label: 'London' });
          expect(new URL(page.url()).search).toBe('');
          await page.getByRole('button', { name: 'Show' }).click();
          await page.getByRole('heading', { name: 'Current weather in London' }).waitFor();
          await page.getByText('Temperature: 12 °C').waitFor();
          expect(new URL(page.url()).searchParams.get('location')).toBe('london');
          expect(await location.inputValue()).toBe('london');
          expect(await page.locator('script').count()).toBe(0);
          await page.goto(`${base}/weather?location=unknown`);
          await page.getByRole('heading', { name: 'Current weather in Singapore' }).waitFor();
          expect(await location.inputValue()).toBe('singapore');
          await page.goto(`${base}/preview`);
          await page.getByLabel('Draft title').fill('A draft <title>');
          await page.getByRole('button', { name: 'Preview draft' }).click();
          await page.getByRole('heading', { name: 'A draft <title>' }).waitFor();
          expect(await page.title()).toBe('A draft <title>');
          await page.goto(`${base}/preview`);
          expect(await page.title()).toBe('Untitled draft');
        } finally {
          await browser.close();
        }
        if (target === 'Cloudflare' && command === 'dev') {
          // Readiness can retry a failed request, so check the cold-start logs too.
          expect(server.output()).not.toMatch(
            /\(void_worker\).*dependency optimized:.*\bhono\/jsx/,
          );
          expect(server.output()).not.toContain('Cannot convert object to primitive value');
        }
      } finally {
        if (server) {
          await killChild(server.child);
        }
        fixture.cleanup();
      }
    },
    45_000,
  );

  it('prerenders loader props and head for selected paths in static output', () => {
    const fixture = createIsolatedPlayground(repository, 'playground/server-components');
    try {
      writeFileSync(
        join(fixture.root, 'void.config.ts'),
        `export default { target: 'node', output: 'static' };`,
      );
      execFileSync('vp', ['build'], { cwd: fixture.root, stdio: 'pipe' });
      const document = readFileSync(join(fixture.root, 'dist/client/posts/42.html'), 'utf8');
      expect(document).toContain('<title>Post 42</title>');
      expect(document).toContain('<h1>Post 42</h1>');
      expect(document).toContain('Nested posts layout');
      expect(document).not.toContain('<script');
      expect(existsSync(join(fixture.root, 'dist/client/posts/43.html'))).toBe(true);
      expect(existsSync(join(fixture.root, 'dist/client/about.html'))).toBe(false);
      expect(existsSync(join(fixture.root, 'dist/client/preview.html'))).toBe(false);
      expect(existsSync(join(fixture.root, 'dist/client/weather.html'))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  }, 30_000);
});
