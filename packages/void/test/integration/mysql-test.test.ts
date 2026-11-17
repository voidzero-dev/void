import { execSync, type ChildProcess } from 'node:child_process';
import { rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  killChild,
  spawnPlaygroundServer,
  startServer,
  type StartedServer,
} from '../../../../test/integration-helpers.ts';
import { startFakeMySqlServer, type FakeMySqlServer } from '../helpers/fake-mysql-server.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = join(ROOT, 'playground/mysql-test');
const ENV_PATH = join(PLAYGROUND, '.env');
const USERS = [
  { id: 1, name: 'Ada', email: 'ada@example.com' },
  { id: 2, name: 'Linus', email: 'linus@example.com' },
];

// workerd cannot evaluate mysql2's CommonJS source or the eval its row parsers use by default.
describe('playground/mysql-test', () => {
  let mysqlServer: FakeMySqlServer;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    mysqlServer = await startFakeMySqlServer(USERS);
    writeFileSync(ENV_PATH, `DATABASE_URL=mysql://void@127.0.0.1:${mysqlServer.port}/app\n`);
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    await mysqlServer?.close();
    try {
      unlinkSync(ENV_PATH);
    } catch {
      // Ignore missing cleanup files between test runs.
    }
  });

  function start(script: 'dev' | 'preview'): Promise<StartedServer> {
    return startServer(
      (port) => (child = spawnPlaygroundServer(ROOT, 'mysql-test', script, port)),
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

  it('queries MySQL through void/db and createDb in dev', async () => {
    const server = await start('dev');
    try {
      await expectUsers(server);
    } finally {
      await stop();
    }
  });

  it('queries MySQL through void/db and createDb in the built Worker', async () => {
    rmSync(join(PLAYGROUND, 'dist'), { recursive: true, force: true });
    execSync('vp run --filter ./playground/mysql-test build', { cwd: ROOT, stdio: 'pipe' });
    const server = await start('preview');
    try {
      await expectUsers(server);
    } finally {
      await stop();
    }
  });
});
