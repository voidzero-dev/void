import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { analyzeApplication } from '../../src/application-routing.ts';
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
