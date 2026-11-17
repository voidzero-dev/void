import { execSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'pglite-server';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  killChild,
  spawnPlaygroundServer,
  startServer,
  type StartedServer,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = join(ROOT, 'playground/pg-api-test');
const ENV_PATH = join(PLAYGROUND, '.env');
const USERS = [
  { id: 1, name: 'Ada', email: 'ada@example.com' },
  { id: 2, name: 'Linus', email: 'linus@example.com' },
];

// No db/migrations and no auth: no other Void module imports pg, so void/db's own import
// must reach workerd prebundled.
describe('playground/pg-api-test', () => {
  let pglite: PGlite;
  let pgServer: ReturnType<typeof createServer>;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.exec(
      'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);',
    );
    for (const user of USERS) {
      await pglite.query('INSERT INTO users (name, email) VALUES ($1, $2)', [
        user.name,
        user.email,
      ]);
    }
    pgServer = createServer(pglite);
    pgServer.listen(0);
    await once(pgServer, 'listening');
    const { port } = pgServer.address() as AddressInfo;
    writeFileSync(ENV_PATH, `DATABASE_URL=postgresql://postgres@127.0.0.1:${port}/postgres\n`);
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
    try {
      unlinkSync(ENV_PATH);
    } catch {
      // Ignore missing cleanup files between test runs.
    }
  });

  function start(script: 'dev' | 'preview'): Promise<StartedServer> {
    return startServer(
      (port) => (child = spawnPlaygroundServer(ROOT, 'pg-api-test', script, port)),
      30_000,
    );
  }

  async function stop(): Promise<void> {
    if (child) {
      await killChild(child);
      child = undefined;
    }
  }

  async function expectUsers({ base, output }: StartedServer): Promise<void> {
    for (const path of ['/api/users', '/api/users/create-db']) {
      const response = await fetch(base + path);
      const result = { path, status: response.status, body: await response.text() };
      expect(result, output().slice(-4000)).toEqual({
        path,
        status: 200,
        body: JSON.stringify(USERS),
      });
    }
  }

  it('queries PostgreSQL through void/db and createDb in dev', async () => {
    const server = await start('dev');
    try {
      await expectUsers(server);
    } finally {
      await stop();
    }
  });

  it('queries PostgreSQL through void/db and createDb in the built Worker', async () => {
    rmSync(join(PLAYGROUND, 'dist'), { recursive: true, force: true });
    execSync('vp run --filter ./playground/pg-api-test build', { cwd: ROOT, stdio: 'pipe' });
    const server = await start('preview');
    try {
      await expectUsers(server);
    } finally {
      await stop();
    }
  });
});
