import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
  type StartedServer,
} from '../../../../test/integration-helpers.ts';
import { startFakeMySqlServer, type FakeMySqlServer } from '../helpers/fake-mysql-server.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/react-router';
let DEV_BASE: string;

describe('playground/react-router dev', { retry: 2 }, () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    const server = await startServer((port) => {
      child = spawn(
        'vp',
        [
          'run',
          '--filter',
          `./${PLAYGROUND}`,
          'dev',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            VOID_INSPECTOR_PORT: 'false',
          },
        },
      );
      return child;
    }, 30_000);
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('applies env.ts to server routes', async () => {
    const response = await fetch(`${DEV_BASE}/api/env`);
    expect(await response.json()).toEqual({ SCHEMA_DEFAULT: 48213 });
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('React Router + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });
});

// React Router owns its request handler; void/db must still reach MySQL from a loader.
describe('playground/react-router with MySQL', () => {
  const USERS = [
    { id: 1, name: 'Ada', email: 'ada@example.com' },
    { id: 2, name: 'Linus', email: 'linus@example.com' },
  ];
  let mysqlServer: FakeMySqlServer;
  let playground: IsolatedPlayground;
  let child: ReturnType<typeof spawn> | undefined;

  beforeAll(async () => {
    mysqlServer = await startFakeMySqlServer(USERS);
    playground = createIsolatedPlayground(ROOT, PLAYGROUND);
    const root = playground.root;
    const configPath = join(root, 'void.config.ts');
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replace(
        'defineConfig({',
        "defineConfig({\n  database: 'mysql',",
      ),
    );
    rmSync(join(root, 'db/migrations'), { recursive: true, force: true });
    rmSync(join(root, 'crons'), { recursive: true, force: true });
    // The import the jobs guide shows. The package entry is Void's Vite plugin, which workerd
    // cannot load.
    mkdirSync(join(root, 'crons'));
    writeFileSync(
      join(root, 'crons/tick.ts'),
      `import { defineScheduled } from 'void';

export const cron = '*/5 * * * *';

export default defineScheduled(async () => {});
`,
    );
    writeFileSync(
      join(root, 'db/schema.ts'),
      `import { int, mysqlTable, varchar } from 'void/schema-mysql';

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
});
`,
    );
    writeFileSync(
      join(root, 'app/routes/api.users.ts'),
      `import { users } from '@schema';
import { db } from 'void/db';

export async function loader() {
  return Response.json(await db.select().from(users));
}
`,
    );
    writeFileSync(
      join(root, 'app/routes/api.user-count.ts'),
      `import { users } from '@schema';
import { db } from 'void/db';

// Built when the module loads, run by every request.
const allUsers = db.select().from(users);

export async function loader() {
  return Response.json((await allUsers).length);
}
`,
    );
    const routesPath = join(root, 'app/routes.ts');
    writeFileSync(
      routesPath,
      readFileSync(routesPath, 'utf8').replace(
        "route('smoke', 'routes/smoke.tsx'),",
        "route('smoke', 'routes/smoke.tsx'),\n  route('api/users', 'routes/api.users.ts'),\n  route('api/user-count', 'routes/api.user-count.ts'),",
      ),
    );
    writeFileSync(
      join(root, '.env'),
      `DATABASE_URL=mysql://void@127.0.0.1:${mysqlServer.port}/app\n`,
    );
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    await mysqlServer?.close();
    playground?.cleanup();
  });

  function start(script: 'dev' | 'preview'): Promise<StartedServer> {
    return startServer((port) => {
      child = spawn('vp', [script, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: playground.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
      });
      return child;
    }, 30_000);
  }

  async function expectUsers({ base, output }: StartedServer): Promise<void> {
    const response = await fetch(`${base}/api/users`);
    const result = { status: response.status, body: await response.text() };
    expect(result, output().slice(-4000)).toEqual({ status: 200, body: JSON.stringify(USERS) });
    // Each request runs the module-level query on its own connection.
    for (const _request of [1, 2]) {
      const count = await fetch(`${base}/api/user-count`);
      expect({ status: count.status, body: await count.text() }, output().slice(-4000)).toEqual({
        status: 200,
        body: String(USERS.length),
      });
    }
  }

  it('queries MySQL through void/db and runs a cron in dev', async () => {
    const server = await start('dev');
    try {
      await expectUsers(server);
      const token = readFileSync(join(playground.root, '.void/dev-trigger-token'), 'utf8').trim();
      const response = await fetch(`${server.base}/__void/scheduled`, {
        method: 'POST',
        headers: { 'x-void-dev-trigger': token },
        body: JSON.stringify({ cron: '*/5 * * * *', scheduledTime: Date.now() }),
      });
      const result = { status: response.status, body: await response.text() };
      expect(result, server.output().slice(-4000)).toEqual({ status: 200, body: '{"ok":true}' });
    } finally {
      await killChild(server.child);
      child = undefined;
    }
  });

  it('queries MySQL through void/db in the built Worker', async () => {
    execFileSync('vp', ['build'], {
      cwd: playground.root,
      stdio: 'pipe',
      env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
      shell: process.platform === 'win32',
    });
    const server = await start('preview');
    try {
      await expectUsers(server);
    } finally {
      await killChild(server.child);
      child = undefined;
    }
  });
});
