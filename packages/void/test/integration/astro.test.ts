import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import spawn from 'cross-spawn';
import { createServer } from 'pglite-server';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
  type StartedServer,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/astro';
let DEV_BASE: string;

function readWranglerConfig(root: string): {
  compatibility_flags?: Array<string>;
  d1_databases?: Array<{ binding: string }>;
  kv_namespaces?: Array<{ binding: string }>;
} {
  return JSON.parse(readFileSync(join(root, '.void-wrangler.jsonc'), 'utf-8'));
}

describe('playground/astro dev', () => {
  const sourceGitignorePath = join(ROOT, PLAYGROUND, '.gitignore');
  const sourceGitignore = readFileSync(sourceGitignorePath, 'utf8');
  let playground: IsolatedPlayground;
  let child: ReturnType<typeof spawn> | undefined;

  const startDev = async () => {
    const server = await startServer((port) => {
      child = spawn(
        process.execPath,
        [
          join(playground.root, 'node_modules/astro/bin/astro.mjs'),
          'dev',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
        ],
        {
          cwd: playground.root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ASTRO_DEV_BACKGROUND: 'false',
            ASTRO_DISABLE_UPDATE_CHECK: 'true',
            VOID_INSPECTOR_PORT: 'false',
          },
        },
      );
      return child;
    }, 20_000);
    DEV_BASE = server.base;
  };

  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, PLAYGROUND);
    // Dev must generate the inferred binding config itself in a fresh fixture.
    rmSync(join(playground.root, '.void-wrangler.jsonc'), { force: true });
    await startDev();
  });

  afterAll(async () => {
    try {
      if (child) {
        await killChild(child);
      }
    } finally {
      playground?.cleanup();
      expect(readFileSync(sourceGitignorePath, 'utf8')).toBe(sourceGitignore);
    }
  });

  it('syncs wrangler config with compat flag and inferred bindings', () => {
    const wranglerConfig = readWranglerConfig(playground.root);

    expect(wranglerConfig.compatibility_flags?.includes('nodejs_als')).toBe(true);
    expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
    expect(existsSync(join(playground.root, 'wrangler.jsonc'))).toBe(false);
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Astro + Void');
  });

  it('navigates to smoke route from home page', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(DEV_BASE);
      await page.click('a[href="/smoke"]');
      await page.waitForURL('**/smoke');
      const d1User = await page.textContent('[data-testid="d1-user"]');
      const kvValue = await page.textContent('[data-testid="kv-value"]');
      expect(d1User).toBe('Alice');
      expect(kvValue).toBe('ok');
    } finally {
      await browser.close();
    }
  });

  // An app without middleware gets Void's dev middleware, which answers the trigger.
  it('runs a cron through the dev trigger endpoint', async () => {
    const token = readFileSync(join(playground.root, '.void/dev-trigger-token'), 'utf8').trim();
    const response = await fetch(`${DEV_BASE}/__void/scheduled`, {
      method: 'POST',
      headers: { 'x-void-dev-trigger': token },
      body: JSON.stringify({ cron: '0 * * * *', scheduledTime: Date.now() }),
    });
    const result = { status: response.status, body: await response.text() };
    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
  });
});

// Astro owns its Worker entry; Void runs it in a request scope for PostgreSQL.
describe('playground/astro with PostgreSQL', () => {
  const USERS = [
    { id: 1, name: 'Ada', email: 'ada@example.com' },
    { id: 2, name: 'Linus', email: 'linus@example.com' },
  ];
  let pglite: PGlite;
  let pgServer: ReturnType<typeof createServer>;
  let playground: IsolatedPlayground;
  let child: ReturnType<typeof spawn> | undefined;
  let dev: StartedServer;
  let connections = 0;
  const USER_MIDDLEWARE = `import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware((_context, next) => next());
`;

  function start(script: 'dev' | 'preview'): Promise<StartedServer> {
    const root = playground.root;
    return startServer((port) => {
      child = spawn(
        process.execPath,
        [
          join(root, 'node_modules/astro/bin/astro.mjs'),
          script,
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
        ],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ASTRO_DEV_BACKGROUND: 'false',
            ASTRO_PREVIEW_BACKGROUND: 'false',
            // Astro's update check writes .astro/settings.json in a fresh project, and the watcher
            // can report that one write twice; the second restarts the dev server mid-request.
            ASTRO_DISABLE_UPDATE_CHECK: 'true',
            VOID_INSPECTOR_PORT: 'false',
          },
        },
      );
      return child;
    }, 30_000);
  }

  // Runs every query of a request on one connection, a query built at module load included.
  async function expectOneConnectionPerRequest({ base, output }: StartedServer): Promise<void> {
    const before = connections;
    const response = await fetch(`${base}/api/user-counts`);
    const result = {
      status: response.status,
      body: await response.text(),
      connections: connections - before,
    };
    expect(result, output().slice(-4000)).toEqual({
      status: 200,
      body: '[2,2,2,2]',
      connections: 1,
    });
  }

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.exec(
      'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);',
    );
    for (const user of USERS) {
      await pglite.query('INSERT INTO users (name, email) VALUES ($1, $2)', [
        user.name,
        user.email,
      ]);
    }
    pgServer = createServer(pglite);
    pgServer.on('connection', () => connections++);
    pgServer.listen(0, '127.0.0.1');
    await once(pgServer, 'listening');
    const { port } = pgServer.address() as AddressInfo;

    playground = createIsolatedPlayground(ROOT, PLAYGROUND);
    const root = playground.root;
    const configPath = join(root, 'void.config.ts');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8')
        .replace('defineConfig({', "defineConfig({\n  database: 'pg',")
        .replace(
          "compatibility_flags: ['nodejs_als']",
          "compatibility_flags: ['nodejs_compat', 'nodejs_als']",
        ),
    );
    rmSync(join(root, 'db/migrations'), { recursive: true, force: true });
    writeFileSync(
      join(root, 'db/schema.ts'),
      `import { pgTable, serial, text } from 'void/schema-pg';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
});
`,
    );
    mkdirSync(join(root, 'src/pages/api'), { recursive: true });
    writeFileSync(
      join(root, 'src/pages/api/users.ts'),
      `import { users } from '@schema';
import { db } from 'void/db';

export const prerender = false;

export async function GET() {
  return Response.json(await db.select().from(users));
}
`,
    );
    writeFileSync(
      join(root, 'src/pages/api/user-counts.ts'),
      `import { users } from '@schema';
import { db } from 'void/db';

export const prerender = false;

// Built when the module loads, run by every request.
const allUsers = db.select().from(users);

export async function GET() {
  const results = await Promise.all([allUsers, allUsers, allUsers, allUsers]);
  return Response.json(results.map((rows) => rows.length));
}
`,
    );
    // The import the jobs guide shows. The package entry is Void's Vite plugin, which workerd
    // cannot load; the dev trigger dispatch imports every cron with the Worker entry.
    writeFileSync(
      join(root, 'crons/tick.ts'),
      `import { defineScheduled } from 'void';

export const cron = '*/5 * * * *';

export default defineScheduled(async () => {});
`,
    );
    writeFileSync(
      join(root, '.env'),
      `DATABASE_URL=postgresql://postgres@127.0.0.1:${port}/postgres\n`,
    );
    // An app's own middleware must not hide the dev trigger endpoints.
    writeFileSync(join(root, 'src/middleware.ts'), USER_MIDDLEWARE);

    dev = await start('dev');
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    if (pgServer) {
      pgServer.close();
      await once(pgServer, 'close');
    }
    await pglite?.close();
    playground?.cleanup();
  });

  it('queries PostgreSQL through void/db from an API route in dev', async () => {
    const response = await fetch(`${dev.base}/api/users`);
    const result = { status: response.status, body: await response.text() };
    expect(result, dev.output().slice(-4000)).toEqual({
      status: 200,
      body: JSON.stringify(USERS),
    });
  });

  it('runs every query of a request on one connection in dev', async () => {
    for (const _request of [1, 2]) {
      await expectOneConnectionPerRequest(dev);
    }
  });

  it('runs a cron that imports defineScheduled from void in dev', async () => {
    const token = readFileSync(join(playground.root, '.void/dev-trigger-token'), 'utf8').trim();
    const response = await fetch(`${dev.base}/__void/scheduled`, {
      method: 'POST',
      headers: { 'x-void-dev-trigger': token },
      body: JSON.stringify({ cron: '*/5 * * * *', scheduledTime: Date.now() }),
    });
    const result = { status: response.status, body: await response.text() };
    expect(result, dev.output().slice(-4000)).toEqual({ status: 200, body: '{"ok":true}' });
    expect(readFileSync(join(playground.root, 'src/middleware.ts'), 'utf8')).toBe(USER_MIDDLEWARE);
  });

  it('runs every query of a request on one connection in the built Worker', async () => {
    // Stop dev so the build and preview run on their own.
    await killChild(dev.child);
    child = undefined;
    execFileSync(
      process.execPath,
      [join(playground.root, 'node_modules/astro/bin/astro.mjs'), 'build'],
      {
        cwd: playground.root,
        stdio: 'pipe',
        env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
      },
    );
    // A plain build moves Wrangler's deploy config aside; `astro preview` puts it back.
    expect(existsSync(join(playground.root, '.wrangler/deploy/config.json'))).toBe(false);
    const server = await start('preview');
    try {
      for (const _request of [1, 2]) {
        await expectOneConnectionPerRequest(server);
      }
    } finally {
      await killChild(server.child);
      child = undefined;
    }
  });
});
