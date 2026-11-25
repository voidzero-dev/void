import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import {
  analogDevTriggerInjectPlugin,
  astroDevTriggerInjectPlugin,
  frameworkTriggersDispatchPath,
  frameworkTriggersPlugin,
  hasOwnAstroMiddleware,
  nitroDevTriggerInjectPlugin,
} from '../../src/plugin-framework-triggers.ts';
import type { QueueBatch } from '../../src/runtime/handler/index.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-fw-triggers-'));
  tempDirs.push(root);
  return root;
}

function callConfigResolved(plugin: ReturnType<typeof frameworkTriggersPlugin>) {
  const hook = plugin.configResolved;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configResolved not callable');
  }
  void fn.call({} as ThisParameterType<typeof fn>, {} as Parameters<typeof fn>[0]);
}

type DevTrigger = (
  request: Request,
  env?: Record<string, unknown>,
  ctx?: unknown,
) => Promise<Response | null>;

async function loadDevTrigger(root: string): Promise<DevTrigger> {
  callConfigResolved(frameworkTriggersPlugin(root, { devTriggerToken: 'tk' }));
  const entry = frameworkTriggersDispatchPath(root);
  const outDir = join(root, '.void', 'test-output');
  // Bundle the emitted entry so its absolute imports also work under native ESM on Windows.
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: entry,
      outDir,
      minify: false,
      rollupOptions: { output: { entryFileNames: 'dev-triggers.mjs' } },
    },
  });
  return (await import(pathToFileURL(join(outDir, 'dev-triggers.mjs')).href)).handleDevTrigger;
}

function triggerRequest(kind: 'scheduled' | 'queue', payload: unknown): Request {
  return new Request(`http://localhost/__void/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-void-dev-trigger': 'tk' },
    body: JSON.stringify(payload),
  });
}

function callConfigureServer(
  plugin: ReturnType<typeof nitroDevTriggerInjectPlugin>,
  serverOverrides: Record<string, unknown> = {},
) {
  const hook = plugin.configureServer;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configureServer not callable');
  }
  const server = {
    httpServer: { once() {} },
    middlewares: { use() {} },
    ...serverOverrides,
  };
  void fn.call({} as ThisParameterType<typeof fn>, server as unknown as Parameters<typeof fn>[0]);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('frameworkTriggersPlugin', () => {
  it('runs every job sharing a schedule once and skips unrelated jobs', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'));
    for (const [name, crons] of [
      ['first', ['0 * * * *']],
      ['second', ['0 * * * *', '0 * * * *', '30 * * * *']],
      ['other', ['*/5 * * * *']],
    ] as const) {
      writeFileSync(
        join(root, 'crons', `${name}.mjs`),
        `export const cron = ${JSON.stringify(crons)};
export default (controller, env, ctx) => env.handlers.${name}(controller, env, ctx);`,
      );
    }
    const handle = await loadDevTrigger(root);
    const env = { handlers: { first: vi.fn(), second: vi.fn(), other: vi.fn() } };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const response = await handle(
      triggerRequest('scheduled', { cron: '0 * * * *', scheduledTime: 1234 }),
      env,
      ctx,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
    for (const handler of [env.handlers.first, env.handlers.second]) {
      expect(handler).toHaveBeenCalledExactlyOnceWith(
        { cron: '0 * * * *', scheduledTime: 1234, noRetry: expect.any(Function) },
        env,
        ctx,
      );
    }
    expect(env.handlers.other).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)(
    'waits for sibling jobs before reporting a handler that can %s',
    async (failureMode) => {
      const root = createTempRoot();
      mkdirSync(join(root, 'crons'));
      writeFileSync(
        join(root, 'crons', 'first.mjs'),
        `export const cron = '0 * * * *';
export default (controller, env) => env.fail();`,
      );
      writeFileSync(
        join(root, 'crons', 'second.mjs'),
        `export const cron = '0 * * * *';
export default (controller, env) => env.sibling();`,
      );
      const handle = await loadDevTrigger(root);
      const failure = new Error('first job failed');
      let finishSibling: () => void = () => {};
      let markStarted: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        finishSibling = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const env = {
        fail: vi.fn(() => {
          if (failureMode === 'throw') {
            throw failure;
          }
          return Promise.reject(failure);
        }),
        sibling: vi.fn(() => {
          markStarted();
          return pending;
        }),
      };
      let settled = false;
      const outcome = handle(
        triggerRequest('scheduled', { cron: '0 * * * *', scheduledTime: 0 }),
        env,
      ).then(
        (response) => {
          settled = true;
          return response;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await Promise.race([started, outcome]);
        expect(env.fail).toHaveBeenCalledOnce();
        expect(env.sibling).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
      } finally {
        finishSibling();
      }
      const error = await outcome;
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        throw new Error('Expected scheduled job failures');
      }
      expect(error.errors).toEqual([failure]);
    },
  );

  it('returns 404 when no job matches the requested schedule', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'));
    writeFileSync(
      join(root, 'crons', 'hourly.mjs'),
      `export const cron = '0 * * * *';
export default (controller, env) => env.run();`,
    );
    const handle = await loadDevTrigger(root);
    const env = { run: vi.fn() };
    const response = await handle(
      triggerRequest('scheduled', { cron: '30 * * * *', scheduledTime: 0 }),
      env,
    );
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: 'No cron handler matches "30 * * * *"' });
    expect(env.run).not.toHaveBeenCalled();
  });

  it.each(['success', 'throw', 'reject'] as const)(
    'preserves first queue decisions when the consumer can %s',
    async (outcome) => {
      const root = createTempRoot();
      mkdirSync(join(root, 'queues'));
      writeFileSync(
        join(root, 'queues', 'emails.mjs'),
        'export default (batch, env) => env.consume(batch);',
      );
      const handle = await loadDevTrigger(root);
      const failure = new Error('after message decisions');
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const env = {
        consume: vi.fn((batch: QueueBatch) => {
          expect(batch.queue).toBe('emails');
          expect(batch.messages).toHaveLength(3);
          expect(batch.messages[0]).toMatchObject({
            id: 'one',
            timestamp: new Date('2026-01-01T00:00:00Z'),
            body: { value: 'one' },
            attempts: 2,
          });
          batch.messages[0].ack();
          batch.messages[0].retry({ delaySeconds: 1 });
          batch.messages[1].retry({ delaySeconds: 9 });
          batch.messages[1].ack();
          if (outcome === 'throw') {
            throw failure;
          }
          if (outcome === 'reject') {
            return Promise.reject(failure);
          }
          batch.ackAll();
        }),
      };
      const response = await handle(
        triggerRequest('queue', {
          queue: 'emails',
          messages: ['one', 'two', 'three'].map((id) => ({
            id,
            timestamp: '2026-01-01T00:00:00Z',
            body: { value: id },
            attempts: 2,
          })),
        }),
        env,
      );
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({
        ok: outcome === 'success',
        decisions: {
          one: { action: 'ack' },
          two: { action: 'retry', delaySeconds: 9 },
          ...(outcome === 'success' ? { three: { action: 'ack' } } : {}),
        },
      });
      expect(env.consume).toHaveBeenCalledOnce();
      if (outcome === 'success') {
        expect(errorLog).not.toHaveBeenCalled();
      } else {
        expect(errorLog).toHaveBeenCalledExactlyOnceWith('[void] queue handler threw:', failure);
      }
    },
  );

  it('reports a failed queue consumer without adding decisions it never made', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'queues'));
    writeFileSync(
      join(root, 'queues', 'emails.mjs'),
      'export default () => { throw new Error("before any decisions"); };',
    );
    const handle = await loadDevTrigger(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handle(
      triggerRequest('queue', {
        queue: 'emails',
        messages: [{ id: 'one', timestamp: '2026-01-01T00:00:00Z', body: {}, attempts: 1 }],
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: false });
  });

  it('marks the dispatch module @ts-nocheck', () => {
    const root = createTempRoot();
    callConfigResolved(frameworkTriggersPlugin(root, { devTriggerToken: 'dev-token-test' }));

    expect(readFileSync(frameworkTriggersDispatchPath(root), 'utf8')).toContain('@ts-nocheck');
  });

  // The generated module embeds the dev trigger token, which is the whole
  // credential of the `/__void/inbox` routes — so it gets the same
  // owner-only mode as `.void/dev-trigger-token`. Windows has no
  // group/other bits, so there is nothing to assert there.
  it.skipIf(process.platform === 'win32')('writes the dispatch module owner-only (0600)', () => {
    const root = createTempRoot();
    const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'dev-token-test' });
    callConfigResolved(plugin);

    expect(statSync(frameworkTriggersDispatchPath(root)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')(
    'tightens a dispatch module left at 0644 by an earlier release',
    () => {
      const root = createTempRoot();
      const target = frameworkTriggersDispatchPath(root);
      mkdirSync(join(root, '.void'), { recursive: true });
      writeFileSync(target, '// stale\n', { mode: 0o644 });
      // Seed the legacy permissions even under a restrictive developer umask.
      chmodSync(target, 0o644);
      expect(statSync(target).mode & 0o777).toBe(0o644);

      const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'dev-token-test' });
      callConfigResolved(plugin);

      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, 'utf8')).toContain(`__DEV_TRIGGER_TOKEN = "dev-token-test"`);
    },
  );

  it('returns null for other methods and paths without reading their bodies', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'hourly.mjs'),
      'export const cron = "0 * * * *"; export default (controller, env) => env.run();',
    );
    writeFileSync(join(root, 'queues', 'emails.mjs'), 'export default (batch, env) => env.run();');
    const handle = await loadDevTrigger(root);
    const env = { run: vi.fn() };
    for (const [method, path] of [
      ['GET', '/__void/scheduled'],
      ['GET', '/__void/queue'],
      ['POST', '/other'],
      ['POST', '/__void/scheduled/extra'],
      ['POST', '/__void/queue/extra'],
    ]) {
      const request = new Request(`http://localhost${path}`, {
        method,
        headers: { 'x-void-dev-trigger': 'tk' },
        ...(method === 'POST' ? { body: '{' } : {}),
      });
      expect(await handle(request, env)).toBeNull();
      expect(request.bodyUsed).toBe(false);
    }
    expect(env.run).not.toHaveBeenCalled();
  });

  it.each(['scheduled', 'queue'] as const)(
    'authenticates %s requests before parsing or invoking handlers',
    async (kind) => {
      const root = createTempRoot();
      mkdirSync(join(root, 'crons'));
      mkdirSync(join(root, 'queues'));
      writeFileSync(
        join(root, 'crons', 'hourly.mjs'),
        'export const cron = "0 * * * *"; export default (controller, env) => env.run();',
      );
      writeFileSync(
        join(root, 'queues', 'emails.mjs'),
        'export default (batch, env) => env.run();',
      );
      const handle = await loadDevTrigger(root);
      const run = vi.fn();
      const cases: Array<{
        headers: Record<string, string>;
        proxyToken?: string;
        authorized: boolean;
      }> = [
        { headers: {}, authorized: false },
        { headers: { 'x-void-dev-trigger': 'wrong' }, authorized: false },
        { headers: { 'x-void-internal': 'proxy' }, authorized: false },
        { headers: { 'x-void-dev-trigger': 'tk' }, authorized: true },
        // A proxy token in the dev Worker env never changes the dev rule.
        { headers: { 'x-void-dev-trigger': 'tk' }, proxyToken: 'proxy', authorized: true },
        {
          headers: { 'x-void-dev-trigger': 'tk', 'x-void-internal': 'wrong' },
          proxyToken: 'proxy',
          authorized: true,
        },
        { headers: { 'x-void-internal': 'proxy' }, proxyToken: 'proxy', authorized: false },
        {
          headers: { 'x-void-dev-trigger': 'wrong', 'x-void-internal': 'proxy' },
          proxyToken: 'proxy',
          authorized: false,
        },
      ];
      for (const { headers, proxyToken, authorized } of cases) {
        run.mockClear();
        const request = new Request(`http://localhost/__void/${kind}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: authorized
            ? JSON.stringify(
                kind === 'scheduled'
                  ? { cron: '0 * * * *', scheduledTime: 0 }
                  : { queue: 'emails', messages: [] },
              )
            : '{',
        });
        const response = await handle(request, { run, __VOID_PROXY_TOKEN: proxyToken });
        expect(response?.status).toBe(authorized ? 200 : 401);
        expect(await response?.json()).toEqual(
          authorized ? { ok: true } : { error: 'unauthorized' },
        );
        expect(run).toHaveBeenCalledTimes(authorized ? 1 : 0);
        expect(request.bodyUsed).toBe(authorized);
      }
    },
  );

  it('matches exact development queue names and preserves decisions across batch retries', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'queues'));
    writeFileSync(
      join(root, 'queues', 'emails.mjs'),
      'export default (batch, env) => env.consume(batch);',
    );
    const handle = await loadDevTrigger(root);
    const env = {
      consume: vi.fn((batch: QueueBatch) => {
        batch.messages[0].ack();
        batch.retryAll({ delaySeconds: 3 });
        batch.ackAll();
        batch.retryAll();
      }),
    };
    const messages = ['one', 'two'].map((id) => ({
      id,
      timestamp: '2026-01-01T00:00:00Z',
      body: {},
      attempts: 1,
    }));
    for (const queue of ['unknown', 'project-emails']) {
      const response = await handle(triggerRequest('queue', { queue, messages }), env);
      expect(response?.status).toBe(404);
      expect(await response?.json()).toEqual({ error: `No queue handler matches "${queue}"` });
    }
    expect(env.consume).not.toHaveBeenCalled();
    const response = await handle(triggerRequest('queue', { queue: 'emails', messages }), env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      ok: true,
      decisions: { one: { action: 'ack' }, two: { action: 'retry', delaySeconds: 3 } },
    });
    expect(env.consume).toHaveBeenCalledOnce();
  });
});

describe('nitroDevTriggerInjectPlugin', () => {
  it('writes Nuxt middleware to <root>/server/middleware/', () => {
    const root = createTempRoot();
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'server' });
    callConfigureServer(plugin);

    const middlewarePath = join(root, 'server', 'middleware', '__void-dev-trigger.ts');
    expect(existsSync(middlewarePath)).toBe(true);
    const code = readFileSync(middlewarePath, 'utf8');
    expect(code).toContain('@ts-nocheck');
    expect(code).toContain(`from "${frameworkTriggersDispatchPath(root)}"`);
    expect(code).toContain('event.context?.cloudflare');
    expect(code).toContain('event.node.req');
  });

  it('writes Analog middleware to <root>/src/server/middleware/', () => {
    const root = createTempRoot();
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'src/server' });
    callConfigureServer(plugin);

    const middlewarePath = join(root, 'src', 'server', 'middleware', '__void-dev-trigger.ts');
    expect(existsSync(middlewarePath)).toBe(true);
  });

  it('appends middleware path to .gitignore', () => {
    const root = createTempRoot();
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'server' });
    callConfigureServer(plugin);

    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('server/middleware/__void-dev-trigger.ts');
  });

  it('does not duplicate the .gitignore line on repeat invocations', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, '.gitignore'),
      'node_modules\nserver/middleware/__void-dev-trigger.ts\n',
    );
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'server' });
    callConfigureServer(plugin);

    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    const occurrences = gitignore
      .split('\n')
      .filter((l) => l.trim() === 'server/middleware/__void-dev-trigger.ts').length;
    expect(occurrences).toBe(1);
  });
});

describe('astroDevTriggerInjectPlugin', () => {
  it('writes src/middleware.ts when no user middleware exists', () => {
    const root = createTempRoot();
    const plugin = astroDevTriggerInjectPlugin(root);
    callConfigureServer(plugin);

    const middlewarePath = join(root, 'src', 'middleware.ts');
    expect(existsSync(middlewarePath)).toBe(true);
    const code = readFileSync(middlewarePath, 'utf8');
    expect(code).toContain("from 'cloudflare:workers'");
    expect(code).toContain(`from "${frameworkTriggersDispatchPath(root)}"`);
  });

  // Next to the app's own middleware, the wrapper around Astro's server entry answers the
  // triggers. A custom Worker entry can skip that server entry.
  it.each([
    [undefined, false],
    ['@astrojs/cloudflare/entrypoints/server', false],
    ['./src/worker.ts', true],
  ])(
    'skips an app with its own middleware and warns only for a custom Worker entry (main: %s)',
    (main, warns) => {
      const root = createTempRoot();
      mkdirSync(join(root, 'src'), { recursive: true });
      const existing = '// user middleware\nexport const onRequest = () => {};\n';
      writeFileSync(join(root, 'src', 'middleware.ts'), existing);
      writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ main }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      callConfigureServer(astroDevTriggerInjectPlugin(root));

      expect(readFileSync(join(root, 'src', 'middleware.ts'), 'utf8')).toBe(existing);
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      if (warns) {
        expect(output).toContain('its own Worker entry (./src/worker.ts)');
        expect(output).toContain('default export of @astrojs/cloudflare/entrypoints/server');
      } else {
        expect(output).toBe('');
      }
    },
  );

  it('treats only middleware that Void did not write as app middleware', () => {
    const root = createTempRoot();
    let onClose: (() => void) | undefined;
    vi.spyOn(process, 'once').mockReturnValue(process);
    expect(hasOwnAstroMiddleware(root)).toBe(false);

    callConfigureServer(astroDevTriggerInjectPlugin(root), {
      httpServer: {
        once(_event: string, cb: () => void) {
          onClose = cb;
        },
      },
    });
    expect(hasOwnAstroMiddleware(root)).toBe(false);

    onClose!();
    writeFileSync(join(root, 'src', 'middleware.ts'), 'export const onRequest = () => {};\n');
    expect(hasOwnAstroMiddleware(root)).toBe(true);
    rmSync(join(root, 'src', 'middleware.ts'));
    mkdirSync(join(root, 'src', 'middleware'));
    writeFileSync(join(root, 'src', 'middleware', 'index.ts'), '');
    expect(hasOwnAstroMiddleware(root)).toBe(true);
  });

  it('stops ignoring src/middleware.ts after the dev server closes', () => {
    const root = createTempRoot();
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    let onClose: (() => void) | undefined;
    // The temp root is removed after each test, so skip the process exit cleanup hook.
    vi.spyOn(process, 'once').mockReturnValue(process);
    callConfigureServer(astroDevTriggerInjectPlugin(root), {
      httpServer: {
        once(_event: string, cb: () => void) {
          onClose = cb;
        },
      },
    });

    expect(existsSync(join(root, 'src', 'middleware.ts'))).toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('src/middleware.ts');

    onClose!();
    expect(existsSync(join(root, 'src', 'middleware.ts'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });

  // A restart sets up the new dev server, with a new plugin, before it closes the old one.
  it.each([
    ['', false],
    [' after it was deleted', true],
  ])(
    'keeps its middleware for the dev server that replaces it on a restart%s',
    (_name, deleted) => {
      const root = createTempRoot();
      const middlewarePath = join(root, 'src', 'middleware.ts');
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(process, 'once').mockReturnValue(process);
      const closeServer: Array<() => void> = [];
      const startServer = () =>
        callConfigureServer(astroDevTriggerInjectPlugin(root), {
          httpServer: {
            once(_event: string, cb: () => void) {
              closeServer.push(cb);
            },
          },
        });

      startServer();
      if (deleted) {
        rmSync(middlewarePath);
      }
      startServer();
      closeServer[0]();
      expect(existsSync(middlewarePath)).toBe(true);
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('src/middleware.ts');
      expect(log).not.toHaveBeenCalled();

      closeServer[1]();
      expect(existsSync(middlewarePath)).toBe(false);
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    },
  );

  // Vite restarts on an .env edit with the same plugins: it sets up this plugin for the new
  // server, then closes the old one.
  it('removes its middleware when the last server closes after Vite restarts the same plugin', () => {
    const root = createTempRoot();
    const middlewarePath = join(root, 'src', 'middleware.ts');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    vi.spyOn(process, 'once').mockReturnValue(process);
    const plugin = astroDevTriggerInjectPlugin(root);
    const closeServer: Array<() => void> = [];
    const startServer = () =>
      callConfigureServer(plugin, {
        httpServer: {
          once(_event: string, cb: () => void) {
            closeServer.push(cb);
          },
        },
      });

    startServer();
    startServer();
    closeServer[0]();
    expect(existsSync(middlewarePath)).toBe(true);

    closeServer[1]();
    expect(existsSync(middlewarePath)).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  });
});

describe('analogDevTriggerInjectPlugin', () => {
  it('writes scheduled + queue route files under src/server/routes/api/__void/', () => {
    const root = createTempRoot();
    const plugin = analogDevTriggerInjectPlugin(root);
    callConfigureServer(plugin);

    const cron = join(root, 'src', 'server', 'routes', 'api', '__void', 'cron-trigger.ts');
    const queue = join(root, 'src', 'server', 'routes', 'api', '__void', 'queue-trigger.ts');
    expect(existsSync(cron)).toBe(true);
    expect(existsSync(queue)).toBe(true);

    const cronCode = readFileSync(cron, 'utf8');
    expect(cronCode).toContain('@ts-nocheck');
    expect(cronCode).toContain(`from "${frameworkTriggersDispatchPath(root)}"`);
    expect(cronCode).toContain("from 'h3'");
    expect(cronCode).toContain('http://localhost/__void/scheduled');
    expect(cronCode).toContain('event.context?.cloudflare');
  });

  it('appends both route paths to .gitignore', () => {
    const root = createTempRoot();
    const plugin = analogDevTriggerInjectPlugin(root);
    callConfigureServer(plugin);

    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('src/server/routes/api/__void/cron-trigger.ts');
    expect(gitignore).toContain('src/server/routes/api/__void/queue-trigger.ts');
  });

  async function proxyTrigger(address: unknown) {
    const root = createTempRoot();
    const plugin = analogDevTriggerInjectPlugin(root);
    let proxy: ((req: unknown, res: unknown, next: (err?: unknown) => void) => unknown) | undefined;
    // The temp root is removed after each test, so skip the process exit cleanup hook.
    const once = vi.spyOn(process, 'once').mockReturnValue(process);
    callConfigureServer(plugin, {
      httpServer: { once() {}, address: () => address },
      middlewares: {
        use(fn: typeof proxy) {
          proxy = fn;
        },
      },
    });
    once.mockRestore();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('ok', { status: 202 }));
    const req = {
      method: 'POST',
      url: '/__void/scheduled',
      headers: { host: 'evil.example/.localhost', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{"cron":"* * * * *"}');
      },
    };
    const res = {
      statusCode: 0,
      body: undefined as Buffer | undefined,
      setHeader() {},
      end(body: Buffer) {
        res.body = body;
      },
    };
    const next = vi.fn();
    await proxy!(req, res, next);
    return { fetchSpy, res, next };
  }

  it('proxies to the bound dev server, not the request Host', async () => {
    const { fetchSpy, res, next } = await proxyTrigger({
      address: '::',
      family: 'IPv6',
      port: 51_234,
    });
    expect(next).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:51234/api/__void/cron-trigger');
    expect(res.statusCode).toBe(202);
    expect(res.body?.toString()).toBe('ok');
  });

  it.each([
    ['0.0.0.0', 'IPv4', 'http://127.0.0.1:51234/api/__void/cron-trigger'],
    ['127.0.0.1', 'IPv4', 'http://127.0.0.1:51234/api/__void/cron-trigger'],
    ['::1', 'IPv6', 'http://[::1]:51234/api/__void/cron-trigger'],
  ])('proxies to the dev server bound to %s', async (bound, family, expected) => {
    const { fetchSpy } = await proxyTrigger({ address: bound, family, port: 51_234 });
    expect(fetchSpy.mock.calls[0][0]).toBe(expected);
  });

  it('leaves trigger requests alone when the dev server is not listening', async () => {
    const { fetchSpy, next } = await proxyTrigger(null);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});
