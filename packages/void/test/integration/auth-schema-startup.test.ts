import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterEach, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const repository = join(import.meta.dirname, '../../../..');
let fixture: IsolatedPlayground;
let child: ReturnType<typeof spawn> | undefined;

afterEach(async () => {
  if (child) {
    await killChild(child);
    child = undefined;
  }
  fixture?.cleanup();
});

function freshAuthApp() {
  fixture = createIsolatedPlayground(repository, 'playground/kitchen-sink');
  for (const path of [
    'pages',
    'routes',
    'middleware',
    'db',
    'crons',
    'queues',
    'email',
    'lib',
    'env.ts',
    'index.html',
  ]) {
    rmSync(join(fixture.root, path), { recursive: true, force: true });
  }
  const write = (path: string, source: string) => {
    const file = join(fixture.root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, source);
  };
  write(
    'vite.config.ts',
    "import { voidPlugin } from 'void'; export default { plugins: [voidPlugin()], resolve: { tsconfigPaths: true } };",
  );
  write('void.config.ts', "export default { auth: { providers: ['email'] } };");
  write(
    'tsconfig.json',
    JSON.stringify({
      extends: './.void/tsconfig.json',
      compilerOptions: { paths: { '@auth-schema': ['./.void/better-auth-schema.ts'] } },
      include: ['**/*.ts'],
    }),
  );
  write(
    'auth.ts',
    `import { defineAuth } from 'void/auth';
export default defineAuth(({ defaults }) => ({
  ...defaults,
  user: { additionalFields: { nickname: { type: 'string', required: false } } },
  plugins: [{
    id: 'table-indexes',
    schema: { user: { fields: {}, indexes: [
      { name: 'user_created_idx', fields: ['createdAt'] },
      { name: 'user_name_created_uidx', fields: ['name', 'createdAt'], unique: true },
    ] } },
  }],
  databaseHooks: { user: { create: { after: async () => {
    const { authFields } = await import('./lib/users');
    authFields();
  } } } },
}));`,
  );
  write(
    'lib/users.ts',
    `import { userTable } from '@auth-schema';
import { getTableConfig } from 'void/schema-d1';
export const authFields = () => Object.keys(userTable);
export const authIndexes = () => getTableConfig(userTable).indexes.map((index) => index.config.name);`,
  );
  write(
    'db/schema.ts',
    `import { userTable } from '@auth-schema';
import { sqliteTable, text } from 'void/schema-d1';
export const postTable = sqliteTable('post', {
  id: text('id').primaryKey(),
  authorId: text('author_id').references(() => userTable.id),
});`,
  );
  write(
    'routes/index.ts',
    `import 'void/db';
import { env } from 'cloudflare:workers';
import { postTable } from '../db/schema';
import { authFields, authIndexes } from '../lib/users';
export const GET = async () => Response.json({
  fields: authFields(),
  author: postTable.authorId.name,
  indexes: authIndexes(),
  databaseIndexes: (await env.DB.prepare("PRAGMA index_list('user')").all()).results.map((index) => index.name),
});`,
  );
}

it('prepares a fresh app whose auth hooks lazily import the generated schema', () => {
  freshAuthApp();
  execFileSync(process.execPath, [join(repository, 'packages/void/dist/cli/cli.mjs'), 'prepare'], {
    cwd: fixture.root,
    stdio: 'pipe',
    timeout: 30_000,
  });
  expect(readFileSync(join(fixture.root, '.void/better-auth-schema.ts'), 'utf8')).toContain(
    '"nickname"',
  );
});

it('starts a fresh Cloudflare app with auth table imports without running prepare first', async () => {
  freshAuthApp();
  const server = await startServer(
    (port) => {
      child = spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: fixture.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
      });
      return child;
    },
    30_000,
    { expectBody: 'nickname' },
  );
  const response = await fetch(server.base);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    fields: expect.arrayContaining(['nickname']),
    author: 'author_id',
    indexes: ['user_created_idx', 'user_name_created_uidx'],
    databaseIndexes: expect.arrayContaining([
      'user_created_idx',
      'user_name_created_uidx',
      'user_email_uidx',
    ]),
  });
});
