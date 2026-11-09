import { once } from 'node:events';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import spawn from 'cross-spawn';
import { createServer } from 'pglite-server';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { killChild, startServer } from '../../../../test/integration-helpers.ts';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import { decodePageData } from '../../src/pages/serialize.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ENV_PATH = join(ROOT, 'playground/pg-test/.env');
type User = { id: number; name: string; email: string };
type Post = { id: number; title: string; author: string };
type PageData = {
  props: {
    users: Array<User>;
    posts: Array<Post>;
  };
};

describe('playground/pg-test', () => {
  let pglite: PGlite;
  let pgServer: ReturnType<typeof createServer>;
  let pgPort: number;
  let devChild: ReturnType<typeof spawn>;
  let BASE: string;

  beforeAll(async () => {
    // 1. Start PGlite + TCP server
    pglite = new PGlite();
    await pglite.waitReady;

    // Run migrations
    const migrationSql = readFileSync(
      join(ROOT, 'playground/pg-test/db/migrations/0000_initial.sql'),
      'utf-8',
    );
    await pglite.exec(migrationSql);

    // Start wire protocol server
    pgServer = createServer(pglite);
    pgServer.listen(0);
    await once(pgServer, 'listening');
    pgPort = (pgServer.address() as import('node:net').AddressInfo).port;

    // 2. Write the single local .env with the dynamic DATABASE_URL.
    const databaseUrl = `postgresql://postgres@127.0.0.1:${pgPort}/postgres`;
    writeFileSync(ENV_PATH, `DATABASE_URL=${databaseUrl}\n`);

    // 3. Start vite dev server
    const server = await startServer((port) => {
      devChild = spawn(
        'vp',
        [
          'run',
          '--filter',
          './playground/pg-test',
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
      return devChild;
    }, 30_000);
    BASE = server.base;
  });

  afterAll(async () => {
    if (devChild) {
      await killChild(devChild);
    }
    if (pgServer) {
      pgServer.close();
      await once(pgServer, 'close');
    }
    if (pglite) {
      await pglite.close();
    }
    try {
      unlinkSync(ENV_PATH);
    } catch {
      // Ignore missing cleanup files between test runs.
    }
  });

  it('renders the database page', async () => {
    const res = await fetch(BASE + '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Database (PostgreSQL)');
  });

  it('creates a user via action', async () => {
    // POST to named action
    const createRes = await fetch(BASE + '/?create-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VoidPages': 'true',
        'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ name: 'Alice', email: 'alice@test.com' }),
      redirect: 'manual',
    });
    expect(createRes.status).toBeLessThan(400);

    // Verify user appears in page props
    const propsRes = await fetch(BASE + '/', {
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
    });
    const data = decodePageData<PageData>(await propsRes.json());
    expect(data.props.users).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Alice', email: 'alice@test.com' })]),
    );
  });

  it('creates a post via action', async () => {
    // Get the user id first
    const propsRes = await fetch(BASE + '/', {
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
    });
    const data = decodePageData<PageData>(await propsRes.json());
    const alice = data.props.users.find((u) => u.name === 'Alice');
    expect(alice).toBeTruthy();
    if (!alice) {
      throw new Error('Expected Alice to exist before creating a post');
    }

    // Create post via named action
    const createRes = await fetch(BASE + '/?create-post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VoidPages': 'true',
        'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        title: 'Hello World',
        body: 'Test post',
        authorId: alice.id,
      }),
      redirect: 'manual',
    });
    expect(createRes.status).toBeLessThan(400);

    // Verify post appears
    const postsRes = await fetch(BASE + '/', {
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
    });
    const postsData = decodePageData<PageData>(await postsRes.json());
    expect(postsData.props.posts).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Hello World', author: 'Alice' })]),
    );
  });

  it('deletes a post via action', async () => {
    const propsRes = await fetch(BASE + '/', {
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
    });
    const data = decodePageData<PageData>(await propsRes.json());
    const post = data.props.posts.find((p) => p.title === 'Hello World');
    expect(post).toBeTruthy();
    if (!post) {
      throw new Error('Expected Hello World post to exist before deleting it');
    }

    const deleteRes = await fetch(BASE + '/?delete-post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VoidPages': 'true',
        'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ id: post.id }),
      redirect: 'manual',
    });
    expect(deleteRes.status).toBeLessThan(400);

    const afterRes = await fetch(BASE + '/', {
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
    });
    const afterData = decodePageData<PageData>(await afterRes.json());
    expect(afterData.props.posts.find((p) => p.title === 'Hello World')).toBeUndefined();
  });

  it('deletes a user and cascade-deletes their posts', async () => {
    // Create a post for Alice first
    const propsRes = await fetch(BASE + '/', {
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
    });
    const data = decodePageData<PageData>(await propsRes.json());
    const alice = data.props.users.find((u) => u.name === 'Alice');

    expect(alice).toBeTruthy();
    if (!alice) {
      throw new Error('Expected Alice to exist before creating a post');
    }

    await fetch(BASE + '/?create-post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VoidPages': 'true',
        'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        title: 'To Be Deleted',
        body: 'Gone soon',
        authorId: alice.id,
      }),
      redirect: 'manual',
    });

    // Delete Alice (should cascade-delete posts)
    const deleteRes = await fetch(BASE + '/?delete-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VoidPages': 'true',
        'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ id: alice.id }),
      redirect: 'manual',
    });
    expect(deleteRes.status).toBeLessThan(400);

    const afterRes = await fetch(BASE + '/', {
      headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
    });
    const afterData = decodePageData<PageData>(await afterRes.json());
    expect(afterData.props.users.find((u) => u.name === 'Alice')).toBeUndefined();
    expect(afterData.props.posts.find((p) => p.author === 'Alice')).toBeUndefined();
  });

  it('API routes: create and list users', async () => {
    // Create user via API
    const createRes = await fetch(BASE + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', email: 'bob@test.com' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as User;
    expect(created.name).toBe('Bob');

    // List users via API
    const listRes = await fetch(BASE + '/api/users');
    expect(listRes.status).toBe(200);
    const users = (await listRes.json()) as Array<User>;
    expect(users).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Bob', email: 'bob@test.com' })]),
    );

    // Get single user
    const getRes = await fetch(BASE + `/api/users/${created.id}`);
    expect(getRes.status).toBe(200);
    const user = (await getRes.json()) as User;
    expect(user.name).toBe('Bob');
  });
});
