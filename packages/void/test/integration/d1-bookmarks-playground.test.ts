import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '../../../..');

describe('playground/d1-bookmarks', () => {
  for (const mode of ['dev', 'preview'] as const) {
    it(`propagates bookmarks only in the fixed variant (${mode})`, async () => {
      const fixture = createIsolatedPlayground(ROOT, 'playground/d1-bookmarks');
      const browser = await chromium.launch();
      let server: Awaited<ReturnType<typeof startServer>> | undefined;
      try {
        // Exercise actual server serialization; fault injection stays in the disposable fixture.
        writeFileSync(
          join(fixture.root, 'routes/api/[variant].ts'),
          `
import { defineHandler } from 'void';
import { loader, action } from '../../src/database.ts';
function fail() {
  throw new Error('D1_ERROR: test failure <details>', { cause: new Error('test RPC disconnect') });
}
export const GET = defineHandler((c) => {
  if (c.req.header('x-demo-test-error') === 'read') fail();
  return loader(c);
});
export const POST = defineHandler(async (c) => {
  if (c.req.header('x-demo-test-error') === 'save') fail();
  const starts = [];
  if (c.req.query('experiment') === 'immediate') {
    c.env = { ...c.env, DB: new Proxy(c.env.DB, {
      get(binding, key) {
        if (key === 'withSession') return (start) => {
          starts.push(start);
          if (starts.length === 2 && c.req.header('x-demo-test-error') === 'immediate-read') fail();
          return binding.withSession(start);
        };
        return Reflect.get(binding, key, binding);
      },
    }) };
  }
  const response = await action(c);
  response.headers.set('x-test-session-starts', JSON.stringify(starts));
  return response;
});
`,
        );
        execSync('vp exec void db migrate', {
          cwd: fixture.root,
          stdio: 'pipe',
        });
        if (mode === 'preview') {
          execSync('vp build', { cwd: fixture.root, stdio: 'pipe' });
        }
        server = await startServer(
          (port) =>
            spawn('vp', [mode, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
              cwd: fixture.root,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
            }),
          60_000,
          { expectBody: 'D1 Bookmark Example' },
        );
        const context = await browser.newContext();
        const page = await context.newPage();
        for (const variant of ['with-bookmark', 'without-bookmark']) {
          const fixed = variant === 'with-bookmark';
          const initial = await context.request.get(`${server.base}/api/${variant}`);
          expect(initial.status()).toBe(200);
          expect(await initial.json()).toMatchObject({ outcome: 'idle', observed: null });

          const write = await context.request.post(`${server.base}/api/${variant}`, {
            maxRedirects: 0,
          });
          expect(write.status()).toBe(303);
          expect(write.headers()['cache-control']).toContain('no-store');
          expect(Boolean(write.headers()['set-cookie']?.includes('d1-demo-bookmark='))).toBe(fixed);
          const read = await context.request.get(`${server.base}${write.headers().location}`);
          const observation = await read.json();
          expect(observation).toMatchObject({ variant, outcome: 'fresh' });
          expect(observation.observed).toBe(observation.expected);
          expect(Boolean(observation.incomingBookmark)).toBe(fixed);
          expect(read.headers()['x-d1-bookmark']).toBe(observation.outgoingBookmark);

          await page.goto(
            `${server.base}/${variant}?experiment=redirect&pressure=0.25&trials=20&probes=50`,
          );
          await page.locator('#app[data-hydrated="true"]').waitFor();
          expect(
            await page.getByRole('checkbox', { name: 'Add replication pressure' }).isChecked(),
          ).toBe(true);
          expect(
            await page.getByRole('combobox', { name: 'Pressure per trial' }).inputValue(),
          ).toBe('0.25');
          expect(
            await page
              .getByRole('combobox', { name: 'Pressure per trial' })
              .locator('option')
              .allTextContents(),
          ).toEqual(['256 KiB', '512 KiB', '1 MiB', '2 MiB']);
          expect(await page.getByRole('combobox', { name: 'Reads per write' }).count()).toBe(0);
          expect(
            await page.getByRole('combobox', { name: 'Pressure writes per save' }).count(),
          ).toBe(0);
          expect(await page.getByRole('button', { name: /^Save and/ }).count()).toBe(0);
          await page.getByRole('combobox', { name: 'Pressure per trial' }).selectOption('0.5');
          expect(
            await page.getByRole('combobox', { name: 'Probes', exact: true }).inputValue(),
          ).toBe('50');
          expect(
            await page.getByRole('combobox', { name: 'Trials', exact: true }).inputValue(),
          ).toBe('20');
          await expect.poll(() => new URL(page.url()).searchParams.get('pressure')).toBe('0.5');
          await page.reload();
          await page.locator('#app[data-hydrated="true"]').waitFor();
          await expect
            .poll(() => page.getByRole('combobox', { name: 'Pressure per trial' }).inputValue())
            .toBe('0.5');
          expect(
            await page.getByRole('combobox', { name: 'Probes', exact: true }).inputValue(),
          ).toBe('50');
          await page.getByRole('button', { name: 'Run trials', exact: true }).click();
          await expect.poll(() => page.locator('.trial-row').count(), { timeout: 30_000 }).toBe(20);
          await expect.poll(() => page.locator('.result h2').textContent()).toBe('Fresh read');
          await page.locator('#app[data-hydrated="true"]').waitFor();
          expect(await page.locator('.result').textContent()).toContain('512 KiB per trial');
          expect(await page.getByRole('link', { name: 'Read again', exact: true }).count()).toBe(0);
          await page.getByRole('checkbox', { name: 'Add replication pressure' }).uncheck();
          await page.getByRole('button', { name: 'Run trials', exact: true }).click();
          await expect.poll(() => page.locator('.trial-row').count(), { timeout: 30_000 }).toBe(20);
          expect(await page.locator('tbody tr.stale').count()).toBe(0);
          expect(
            await page.getByText('20 completed · 20 fresh · 0 stale · 0 errored').count(),
          ).toBe(1);
          expect(await page.locator('.result').textContent()).toContain('Off');

          const immediate = await context.request.post(
            `${server.base}/api/${variant}?experiment=immediate&pressure=1`,
            { maxRedirects: 0 },
          );
          expect(immediate.status()).toBe(200);
          expect(immediate.headers().location).toBeUndefined();
          expect(immediate.headers()['set-cookie']?.includes('d1-demo-bookmark=')).not.toBe(true);
          const immediateObservation = await immediate.json();
          expect(immediateObservation).toMatchObject({
            experiment: 'immediate',
            variant,
            pressureMiB: 1,
            outcome: 'fresh',
            writeBookmark: expect.any(String),
            outgoingBookmark: expect.any(String),
          });
          expect(immediateObservation.observed).toBe(immediateObservation.expected);
          expect(immediateObservation.incomingBookmark).toBe(
            fixed ? immediateObservation.writeBookmark : null,
          );
          expect(immediate.headers()['x-d1-bookmark']).toBe(immediateObservation.outgoingBookmark);
          expect(immediateObservation.reads).toBeUndefined();
          expect(JSON.parse(immediate.headers()['x-test-session-starts'])).toEqual([
            'first-unconstrained',
            fixed ? immediateObservation.writeBookmark : 'first-unconstrained',
          ]);
          for (const count of [1, 16, 999]) {
            const sampled = await context.request.post(
              `${server.base}/api/${variant}?experiment=immediate&reads=${count}&writes=${count}&pressure=0.25`,
            );
            const sampledObservation = await sampled.json();
            expect(sampled.status()).toBe(200);
            expect(sampledObservation.pressureMiB).toBe(0.25);
            expect(sampledObservation.reads).toBeUndefined();
            expect(sampledObservation.pressureWrites).toBeUndefined();
            expect(JSON.parse(sampled.headers()['x-test-session-starts'])).toHaveLength(2);
          }

          await page.getByRole('combobox', { name: 'Read timing' }).selectOption('immediate');
          await page.getByRole('button', { name: 'Run trials', exact: true }).click();
          await expect.poll(() => page.locator('.trial-row').count(), { timeout: 30_000 }).toBe(20);
          expect(await page.locator('.result h2').textContent()).toBe('Fresh read');
          expect(await page.locator('.result').textContent()).toContain('Immediate server read');
          expect(await page.locator('.result').textContent()).toContain('Read session bookmark');
        }
        for (const size of [0.25, 0.5, 1, 2]) {
          const response = await context.request.post(
            `${server.base}/api/with-bookmark?pressure=${size}`,
          );
          expect(response.status()).toBe(200);
          expect(await response.json()).toMatchObject({ pressureMiB: size, outcome: 'fresh' });
        }
        for (const size of [4, 16, 32, 64, 999999]) {
          const invalid = await context.request.post(
            `${server.base}/api/with-bookmark?pressure=${size}`,
          );
          expect(await invalid.json()).toMatchObject({ pressureMiB: 0, outcome: 'fresh' });
        }
        const probe = await context.request.get(`${server.base}/api/routing`);
        expect(probe.status()).toBe(200);
        expect(await probe.json()).toMatchObject({
          path: 'void-run',
          metadata: { rows_written: 0 },
        });
        const bookmark = (await context.cookies()).find(
          (cookie) => cookie.name === 'd1-demo-bookmark',
        );
        expect(bookmark).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
        expect((await context.request.get(`${server.base}/api/unknown`)).status()).toBe(404);
        expect(
          (
            await context.request.post(`${server.base}/api/with-bookmark`, {
              headers: { origin: 'https://other.example' },
            })
          ).status(),
        ).toBe(403);

        const readFailure = await context.request.get(
          `${server.base}/api/with-bookmark?expected=acknowledged-revision`,
          { headers: { 'x-demo-test-error': 'read' } },
        );
        expect(readFailure.status()).toBe(500);
        expect(readFailure.headers()['cache-control']).toContain('no-store');
        expect(await readFailure.json()).toMatchObject({
          outcome: 'errored',
          expected: 'acknowledged-revision',
          observed: null,
          error: {
            phase: 'read',
            status: 500,
            causes: [
              {
                name: 'Error',
                message: 'D1_ERROR: test failure <details>',
                stack: expect.any(String),
              },
              { name: 'Error', message: 'test RPC disconnect', stack: expect.any(String) },
            ],
          },
        });

        const immediateReadFailure = await context.request.post(
          `${server.base}/api/with-bookmark?experiment=immediate`,
          { headers: { 'x-demo-test-error': 'immediate-read' }, maxRedirects: 0 },
        );
        expect(immediateReadFailure.status()).toBe(500);
        const failedSamples = await immediateReadFailure.json();
        expect(failedSamples).toMatchObject({
          experiment: 'immediate',
          outcome: 'errored',
          expected: expect.any(String),
          observed: null,
          writeBookmark: expect.any(String),
          error: { phase: 'read', status: 500 },
        });
        expect(failedSamples.reads).toBeUndefined();

        await page.goto(`${server.base}/without-bookmark`);
        await page.locator('#app[data-hydrated="true"]').waitFor();
        await page.getByRole('checkbox', { name: 'Add replication pressure' }).uncheck();
        let writes = 0;
        await page.route('**/api/without-bookmark*', async (route) => {
          const request = route.request();
          const headers = { ...request.headers() };
          if (request.method() === 'POST' && ++writes >= 2) headers['x-demo-test-error'] = 'save';
          await route.continue({ headers });
        });
        await page.getByRole('button', { name: 'Run trials', exact: true }).click();
        await expect
          .poll(() => page.locator('.result h2').textContent())
          .toBe('Errored — trial did not complete');
        expect(await page.getByText('1 completed · 1 fresh · 0 stale · 1 errored').count()).toBe(1);
        expect(await page.locator('tbody tr.fresh').count()).toBe(1);
        expect(await page.locator('tbody tr.errored').count()).toBe(1);
        expect(await page.locator('[role="alert"]').textContent()).toContain(
          'write may have committed',
        );
        await page.locator('.error-details details summary').click();
        expect(await page.locator('.error-details details').textContent()).toContain(
          'test RPC disconnect',
        );
        expect(await page.locator('.error-details details').textContent()).toContain(
          'D1_ERROR: test failure <details>',
        );
        expect(writes).toBe(2);
        await page.getByRole('button', { name: 'Run trials', exact: true }).click();
        await expect
          .poll(() => page.getByText('0 completed · 0 fresh · 0 stale · 1 errored').count())
          .toBe(1);
        expect(writes).toBe(3);
        await context.close();
      } finally {
        await browser.close();
        if (server) {
          await killChild(server.child);
        }
        fixture.cleanup();
      }
    }, 120_000);
  }
});
