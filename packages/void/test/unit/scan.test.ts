import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { analyzeApplication } from '../../src/application-routing.ts';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import { readConfig } from '../../src/config.ts';
import type { RouteEnvironment } from '../../src/router/parse-filename.ts';
import { scanRoutePatternsSync } from '../../src/router/scan.ts';

const TMP = join(import.meta.dirname, '__tmp_scan_test__');

async function scanRoutes(root: string, options?: { environment?: RouteEnvironment }) {
  const config = readConfig(root);
  return (await analyzeApplication(root, { config, environment: options?.environment })).scan;
}

function createFile(path: string, content = 'export const GET = () => {}') {
  const full = join(TMP, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('scanRoutes', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it.each([
    ['a Void Pages app', {}, true],
    ['a Nuxt app, whose pages/ nests routes', { nuxt: '1.0.0' }, false],
  ])('checks page routes in %s', async (_, dependencies, throws) => {
    createFile('package.json', JSON.stringify({ dependencies }));
    createFile('pages/users.vue', '<template><NuxtPage /></template>');
    createFile('pages/users/index.vue', '<template><div /></template>');

    const scan = scanRoutes(TMP);
    if (throws) {
      await expect(scan).rejects.toThrow('pages: Multiple page files resolve to the same route:');
    } else {
      expect((await scan).pages.pages.map((page) => page.componentPath).sort()).toEqual([
        'users.vue',
        'users/index.vue',
      ]);
    }
  });

  it('discovers route files with methods from exports', async () => {
    createFile('routes/api/hello.ts', 'export const GET = () => {}');
    createFile(
      'routes/api/users/index.ts',
      'export const GET = () => {}\nexport const POST = () => {}',
    );

    const result = await scanRoutes(TMP);
    expect(result.routes).toHaveLength(2);

    const hello = result.routes.find((r) => r.pattern === '/api/hello')!;
    expect(hello.methods).toEqual(['GET']);

    const users = result.routes.find((r) => r.pattern === '/api/users')!;
    expect(users.methods).toEqual(['GET', 'POST']);
    expect(result.jobs).toEqual([]);
  });

  it.each(
    ['tsx', 'jsx'].flatMap((ext) =>
      ([undefined, 'dev', 'prod'] as const).map((environment) => ({ ext, environment })),
    ),
  )(
    'discovers .$ext handlers and generates types for environment=$environment',
    async ({ ext, environment }) => {
      createFile(`routes/api/hello.${ext}`, 'export const GET = () => <h1>Hello</h1>;');
      createFile(`routes/api/env.dev.${ext}`, 'export const GET = () => <p>Dev</p>;');
      createFile(`routes/api/env.prod.${ext}`, 'export const POST = () => <p>Prod</p>;');
      createFile(`routes/.well-known/status.${ext}`, 'export const GET = () => <p>OK</p>;');
      createFile(`routes/_private.${ext}`, 'export const GET = () => <p>Private</p>;');
      createFile(`routes/.cache/ignored.${ext}`);

      const result = await scanRoutes(TMP, { environment });
      const expected = [
        `.well-known/status.${ext}`,
        ...(environment !== 'prod' ? [`api/env.dev.${ext}`] : []),
        ...(environment !== 'dev' ? [`api/env.prod.${ext}`] : []),
        `api/hello.${ext}`,
      ];
      expect(result.routes.map((route) => route.filePath).sort()).toEqual(expected);
      expect(result.routes.find((route) => route.pattern === '/api/hello')?.methods).toEqual([
        'GET',
      ]);
      const { dts } = generateRouteTypes(result, join(TMP, 'routes'), join(TMP, '.void'));
      expect(dts).toContain('"/api/hello": {');
      for (const file of expected) {
        expect(dts).toContain(`typeof import("../routes/${file}")`);
      }
      if (environment) {
        expect(dts).not.toContain(`env.${environment === 'dev' ? 'prod' : 'dev'}.${ext}`);
      }
    },
  );

  it.each([undefined, 'dev', 'prod'] as const)(
    'keeps pages for environment=%s and writes one action key for a .dev + .prod pair',
    async (environment) => {
      createFile('pages/debug.dev.tsx', 'export default () => null;');
      createFile('pages/home.dev.tsx', 'export default () => null;');
      createFile('pages/home.dev.server.ts', 'export const action = () => ({});');
      createFile('pages/home.prod.tsx', 'export default () => null;');
      createFile('pages/home.prod.server.ts', 'export const actions = { save: () => ({}) };');

      const result = await scanRoutes(TMP, { environment });
      const expected = [
        ...(environment !== 'prod' ? ['debug.dev.tsx', 'home.dev.tsx'] : []),
        ...(environment !== 'dev' ? ['home.prod.tsx'] : []),
      ];
      expect(result.pages.pages.map((page) => page.componentPath).sort()).toEqual(expected);

      const { dts } = generateRouteTypes(
        result,
        join(TMP, 'routes'),
        join(TMP, '.void'),
        join(TMP, 'pages'),
      );
      const actionMap = dts.split('  interface PageActionMap {')[1]!;
      expect(actionMap.split('"/home": {')).toHaveLength(2);
      for (const env of ['dev', 'prod'] as const) {
        const companion = `typeof import("../pages/home.${env}.server.ts")`;
        if (environment === undefined || environment === env) {
          expect(actionMap).toContain(companion);
        } else {
          expect(dts).not.toContain(`home.${env}`);
        }
      }
      expect(actionMap.includes('} | {')).toBe(environment === undefined);
    },
  );

  it('does not filter the pages of a framework app', async () => {
    createFile('package.json', JSON.stringify({ dependencies: { nuxt: '1.0.0' } }));
    createFile('pages/debug.dev.vue', '<template><div /></template>');

    const result = await scanRoutes(TMP, { environment: 'prod' });
    expect(result.pages.pages.map((page) => page.componentPath)).toEqual(['debug.dev.vue']);
  });

  it.each(['tsx', 'jsx'])('keeps .%s out of cron and queue discovery', async (ext) => {
    createFile(`routes/hello.${ext}`, 'export const GET = () => <p>Hello</p>;');
    createFile(`crons/sync.${ext}`, 'export const cron = "0 * * * *"; export default () => {};');
    createFile(`queues/emails.${ext}`, 'export default async () => {};');

    const result = await scanRoutes(TMP);
    expect(result.routes.map((route) => route.filePath)).toEqual([`hello.${ext}`]);
    expect(result.jobs).toEqual([]);
    expect(result.queues).toEqual([]);
  });

  it('discovers conventions under explicit sourceDir only', async () => {
    createFile('void.json', JSON.stringify({ sourceDir: 'src' }));
    createFile('routes/api/root.ts', 'export const GET = () => {}');
    createFile('src/routes/api/hello.ts', 'export const GET = () => {}');
    createFile('src/middleware/01.logger.ts');
    createFile('src/crons/sync.ts', 'export const cron = "0 * * * *"\nexport default () => {}');
    createFile('src/queues/emails.ts', 'export default async () => {}');
    createFile('src/pages/index.tsx', 'export default function Index() { return null; }');

    const result = await scanRoutes(TMP);

    expect(result.routes.map((route) => route.pattern)).toEqual(['/api/hello']);
    expect(result.middleware).toEqual([{ order: 1, filePath: '01.logger.ts' }]);
    expect(result.jobs.map((job) => job.name)).toEqual(['sync']);
    expect(result.queues.map((queue) => queue.name)).toEqual(['emails']);
    expect(result.pages.pages.map((page) => page.pattern)).toEqual(['/']);
  });

  it('ignores files starting with _', async () => {
    createFile('routes/api/hello.ts');
    createFile('routes/api/_utils.ts');

    const result = await scanRoutes(TMP);
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].pattern).toBe('/api/hello');
  });

  it('discovers routes under .well-known and ignores other dot paths', async () => {
    createFile('routes/.well-known/security.txt.ts');
    createFile('routes/.cache/hello.ts');

    const result = await scanRoutes(TMP);
    expect(result.routes.map((route) => route.pattern)).toEqual(['/.well-known/security.txt']);
  });

  it('discovers and sorts middleware by numeric prefix', async () => {
    createFile('middleware/02.auth.ts');
    createFile('middleware/01.logger.ts');

    const result = await scanRoutes(TMP);
    expect(result.middleware).toHaveLength(2);
    expect(result.middleware[0].order).toBe(1);
    expect(result.middleware[1].order).toBe(2);
    expect(result.jobs).toEqual([]);
  });

  it('handles missing middleware directory', async () => {
    createFile('routes/hello.ts');
    // No middleware/ directory

    const result = await scanRoutes(TMP);
    expect(result.middleware).toEqual([]);
    expect(result.routes).toHaveLength(1);
    expect(result.jobs).toEqual([]);
  });

  it('sorts catch-all routes last', async () => {
    createFile('routes/[...].ts', 'export const GET = () => {}');
    createFile('routes/api/hello.ts', 'export const GET = () => {}');

    const result = await scanRoutes(TMP);
    expect(result.routes[0].pattern).toBe('/api/hello');
    expect(result.routes[1].pattern).toBe('/*');
  });

  it('sorts a static route before a dynamic sibling', async () => {
    // Static '/users/new' must register before '/users/:id' (Hono resolves overlap by registration order).
    createFile('routes/users/[id].ts', 'export const GET = () => {}');
    createFile('routes/users/new.ts', 'export const GET = () => {}');

    const result = await scanRoutes(TMP);
    expect(result.routes.map((route) => route.pattern)).toEqual(['/users/new', '/users/:id']);
  });

  it('prefers a static segment over a dynamic one at the same depth', async () => {
    createFile('routes/posts/[slug]/edit.ts', 'export const GET = () => {}');
    createFile('routes/posts/featured/edit.ts', 'export const GET = () => {}');

    const result = await scanRoutes(TMP);
    expect(result.routes.map((route) => route.pattern)).toEqual([
      '/posts/featured/edit',
      '/posts/:slug/edit',
    ]);
  });

  it('discovers cron jobs from crons directory', async () => {
    createFile('routes/api/hello.ts');
    createFile('crons/sync.ts', 'export const cron = "0 * * * *"\nexport default () => {}');
    createFile(
      'crons/reports/daily.mjs',
      'export const cron = "0 0 * * *"\nexport default async () => {}',
    );

    const result = await scanRoutes(TMP);
    expect(result.jobs).toEqual([
      { filePath: 'reports/daily.mjs', name: 'reports/daily', crons: ['0 0 * * *'] },
      { filePath: 'sync.ts', name: 'sync', crons: ['0 * * * *'] },
    ]);
  });

  it('reads the exported cron rather than matching comments or string contents', async () => {
    createFile(
      'crons/actual.ts',
      `// export const cron = "1 * * * *";
const example = 'export const cron = "2 * * * *"';
export const cron = ["0 * * * *", \`30 * * * *\`] as const;
export default () => {};`,
    );
    const result = await scanRoutes(TMP);
    expect(result.jobs).toEqual([
      { filePath: 'actual.ts', name: 'actual', crons: ['0 * * * *', '30 * * * *'] },
    ]);
  });

  it('ignores underscored job files and directories', async () => {
    createFile('routes/api/hello.ts');
    createFile('crons/_internal.ts', 'export const cron = "0 * * * *"');
    createFile('crons/_private/report.ts', 'export const cron = "0 0 * * *"');

    const result = await scanRoutes(TMP);
    expect(result.jobs).toEqual([]);
  });

  it('throws when a job is missing cron export', async () => {
    createFile('routes/api/hello.ts');
    createFile('crons/sync.ts', 'export default () => {}');

    await expect(scanRoutes(TMP)).rejects.toThrow(
      "cron: Invalid job file 'sync.ts'. Add `export const cron",
    );
  });

  it('discovers queue consumers from queues directory', async () => {
    createFile('routes/api/hello.ts');
    createFile('queues/emails.ts', 'export default async () => {}');

    const result = await scanRoutes(TMP);
    expect(result.queues).toEqual([
      {
        filePath: 'emails.ts',
        name: 'emails',
        bindingName: 'QUEUE_EMAILS',
      },
    ]);
  });

  it('ignores _-prefixed queue files', async () => {
    createFile('routes/api/hello.ts');
    createFile('queues/_helpers.ts', 'export const x = 1');
    createFile('queues/_private/test.ts', 'export const x = 1');

    const result = await scanRoutes(TMP);
    expect(result.queues).toEqual([]);
  });

  it('handles missing queues directory', async () => {
    createFile('routes/api/hello.ts');

    const result = await scanRoutes(TMP);
    expect(result.queues).toEqual([]);
  });

  it('includes .dev routes and excludes .prod routes in dev', async () => {
    createFile('routes/api/always.ts', 'export const GET = () => {}');
    createFile('routes/api/hello.dev.ts', 'export const GET = () => {}');
    createFile('routes/api/hello.prod.ts', 'export const GET = () => {}');

    const result = await scanRoutes(TMP, { environment: 'dev' });
    expect(result.routes.map((r) => r.filePath)).toEqual(['api/always.ts', 'api/hello.dev.ts']);
  });

  it('includes .prod routes and excludes .dev routes in prod', async () => {
    createFile('routes/api/always.ts', 'export const GET = () => {}');
    createFile('routes/api/hello.dev.ts', 'export const GET = () => {}');
    createFile('routes/api/hello.prod.ts', 'export const GET = () => {}');

    const result = await scanRoutes(TMP, { environment: 'prod' });
    expect(result.routes.map((r) => r.filePath)).toEqual(['api/always.ts', 'api/hello.prod.ts']);
  });

  it('includes every route when no environment is specified', async () => {
    createFile('routes/api/always.ts', 'export const GET = () => {}');
    createFile('routes/api/hello.dev.ts', 'export const GET = () => {}');
    createFile('routes/api/hello.prod.ts', 'export const GET = () => {}');

    const result = await scanRoutes(TMP);
    expect(result.routes.map((r) => r.filePath).sort()).toEqual([
      'api/always.ts',
      'api/hello.dev.ts',
      'api/hello.prod.ts',
    ]);
  });

  it('filters websocket routes by environment', async () => {
    createFile('routes/chat.dev.ws.ts', 'export default defineWebSocket({})');
    createFile('routes/chat.prod.ws.ts', 'export default defineWebSocket({})');

    const dev = await scanRoutes(TMP, { environment: 'dev' });
    const prod = await scanRoutes(TMP, { environment: 'prod' });

    expect(dev.websockets?.map((r) => r.filePath)).toEqual(['chat.dev.ws.ts']);
    expect(prod.websockets?.map((r) => r.filePath)).toEqual(['chat.prod.ws.ts']);
  });

  it('discovers all WebSocket route extensions separately from HTTP handlers', async () => {
    createFile('routes/tsx.tsx', 'export const GET = () => <p>TSX</p>;');
    createFile('routes/jsx.jsx', 'export const GET = () => <p>JSX</p>;');
    for (const ext of ['ts', 'mts', 'js', 'mjs', 'tsx', 'jsx']) {
      createFile(`routes/chat-${ext}.ws.${ext}`, 'export default defineWebSocket({});');
    }
    const result = await scanRoutes(TMP);
    expect(result.websockets?.map((route) => route.filePath).sort()).toEqual([
      'chat-js.ws.js',
      'chat-jsx.ws.jsx',
      'chat-mjs.ws.mjs',
      'chat-mts.ws.mts',
      'chat-ts.ws.ts',
      'chat-tsx.ws.tsx',
    ]);
    expect(result.routes.map((route) => route.pattern)).toEqual(['/jsx', '/tsx']);
  });
});

describe('sync scanners', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('scanRoutePatternsSync filters routes by environment', () => {
    createFile('routes/api/always.ts');
    createFile('routes/api/hello.dev.ts');
    createFile('routes/api/hello.prod.ts');

    expect(scanRoutePatternsSync(TMP, undefined, 'dev').map((r) => r.filePath)).toEqual([
      'api/always.ts',
      'api/hello.dev.ts',
    ]);
    expect(scanRoutePatternsSync(TMP, undefined, 'prod').map((r) => r.filePath)).toEqual([
      'api/always.ts',
      'api/hello.prod.ts',
    ]);
    expect(
      scanRoutePatternsSync(TMP)
        .map((r) => r.filePath)
        .sort(),
    ).toEqual(['api/always.ts', 'api/hello.dev.ts', 'api/hello.prod.ts']);
  });
});
