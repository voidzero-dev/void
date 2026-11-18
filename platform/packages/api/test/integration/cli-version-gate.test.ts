import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import type { Db } from '../../src/db.ts';
import app from '../../src/index.ts';
import { MIN_CLI_VERSION } from '../../src/middleware/cli-version.ts';
import { projects } from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  type TestEnv,
} from './helpers.ts';
import { setTestDb } from './setup.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

type OutdatedBody = {
  error: string;
  message: string;
  minVersion: string;
  clientVersion?: string;
};

/**
 * Confirms `checkCliVersionOrRespond` rejects stale CLIs at every deploy
 * endpoint they could plausibly hit, AND that it correctly defers to
 * project-level authorization (404 / 403 / 410) for missing, foreign,
 * and deleting projects.
 *
 * Pre-direct-r2 CLIs (void@<0.7.0) send multipart bodies to /deploy, which
 * has no multipart handler. The gate's content-type sniff fires before any
 * JSON parse so those users see the upgrade message instead of an opaque
 * "invalid JSON body" 400 — but only on requests that are otherwise
 * authorized for the target project.
 */
describe('cliVersionGate — deploy endpoints (passing the gate)', () => {
  it('rejects multipart POST /deploy with 426 cli_outdated (pre-direct-r2 CLI shape)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mp-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'multipart/form-data; boundary=----xyz',
        },
        body: '------xyz\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n{}\r\n------xyz--\r\n',
      }),
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as OutdatedBody;
    expect(body.error).toBe('cli_outdated');
    expect(body.minVersion).toBe(MIN_CLI_VERSION);
    expect(body.message).toMatch(/multipart/i);
    expect(body.message).toMatch(/npm i -g void@latest/);
  });

  it('rejects old X-Void-CLI-Version header on POST /deploy/upload-urls', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'old-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Void-CLI-Version': '0.6.0',
        },
        body: JSON.stringify({ assets: [] }),
      }),
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as OutdatedBody;
    expect(body.error).toBe('cli_outdated');
    expect(body.clientVersion).toBe('0.6.0');
    expect(body.minVersion).toBe(MIN_CLI_VERSION);
  });

  it('rejects old X-Void-CLI-Version header on POST /deploy/preflight', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pf-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Void-CLI-Version': '0.5.99',
        },
        body: JSON.stringify({ assetManifest: {} }),
      }),
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as OutdatedBody;
    expect(body.error).toBe('cli_outdated');
  });

  it('rejects multipart POST /deploy/upload-urls with 426 (must run before body parsing)', async () => {
    // The gate runs at handler entry, before body parsing, so a stale CLI
    // sending multipart gets the 426 upgrade message instead of an opaque
    // "invalid JSON body" 400.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mp-uu-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'multipart/form-data; boundary=----xyz',
        },
        body: '------xyz\r\nContent-Disposition: form-data; name="x"\r\n\r\nhi\r\n------xyz--\r\n',
      }),
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as OutdatedBody;
    expect(body.error).toBe('cli_outdated');
    expect(body.message).toMatch(/multipart/i);
  });

  it('rejects unparseable X-Void-CLI-Version (fail closed)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'fail-closed-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Void-CLI-Version': 'garbage',
        },
        body: JSON.stringify({ assets: [] }),
      }),
      env,
    );

    expect(res.status).toBe(426);
    const body = (await res.json()) as OutdatedBody;
    expect(body.error).toBe('cli_outdated');
    expect(body.clientVersion).toBe('garbage');
    expect(body.message).toMatch(/unrecognized/i);
  });

  it('does not gate /me — old CLIs can still introspect their session', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/me', {
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'X-Void-CLI-Version': '0.0.1',
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
  });

  it('passes through requests with a current version header', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'curr-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Void-CLI-Version': MIN_CLI_VERSION,
        },
        body: JSON.stringify({ assets: [] }),
      }),
      env,
    );

    // Past the gate — handler returns a non-426 status for a valid
    // empty-asset request. Specific status doesn't matter; we only need
    // to confirm we did NOT short-circuit at 426.
    expect(res.status).not.toBe(426);
  });
});

/**
 * Project-authorization checks must run BEFORE the CLI version gate so a
 * stale CLI hitting a missing / foreign / deleting project gets the more
 * specific 404 / 403 / 410 first instead of a misleading "upgrade your
 * CLI" 426. Otherwise a user who typo'd a project name (or lost access)
 * would be told to upgrade when in fact the upgrade won't fix anything.
 */
describe('cliVersionGate — defers to project authorization', () => {
  it('returns 404 (not 426) when project does not exist, even with multipart body', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent/deploy', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'multipart/form-data; boundary=----xyz',
        },
        body: '------xyz--\r\n',
      }),
      env,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('project not found');
  });

  it('returns 403 (not 426) when project belongs to another user, even with stale version header', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const aliceProject = await createTestProject(env.db, alice.id, 'alice-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${aliceProject.id}/deploy/upload-urls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bob.jwt}`,
          'Content-Type': 'application/json',
          'X-Void-CLI-Version': '0.0.1',
        },
        body: JSON.stringify({ assets: [] }),
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('returns 410 (not 426) when project is being deleted, even with multipart body', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'deleting-app');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'multipart/form-data; boundary=----xyz',
        },
        body: '------xyz--\r\n',
      }),
      env,
    );

    expect(res.status).toBe(410);
  });

  // /preflight checks `status === 'deleting'` like the other two endpoints, so
  // a stale CLI gets 410 rather than 426 and a current CLI never body-parses a
  // doomed deploy.
  it('returns 410 (not 426) on /deploy/preflight when project is being deleted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pf-deleting-app');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
          'X-Void-CLI-Version': '0.0.1',
        },
        body: JSON.stringify({ assetManifest: {} }),
      }),
      env,
    );

    expect(res.status).toBe(410);
  });

  // /upload-urls re-reads the project status under a FOR SHARE lock, so a
  // teardown that commits AFTER the unlocked early-out 410 read but BEFORE
  // the share lock still surfaces as 410 rather than serving presigned URLs
  // against a being-deleted bucket.
  //
  // Mechanism: wrap env.db.transaction with a Proxy that pauses before delegating to
  // the real implementation. Between handler entry's reads and the tx,
  // we directly UPDATE projects.status='deleting' through realDb (the
  // proxy doesn't intercept update()), then release the tx. The in-tx
  // re-read sees the mutated state and throws UPLOAD_URLS_PROJECT_DELETING.
  it('returns 410 when project flips to deleting between handler entry and FOR-SHARE acquisition', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'uu-race-app');

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let beforeTxResolver: (() => void) | undefined;
    let beforeTxReached: (() => void) | undefined;
    const beforeTxReachedPromise = new Promise<void>((r) => {
      beforeTxReached = r;
    });
    let beforeTxHoldFired = false;
    const wrappedDb: Db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (async (fn: any) => {
            if (!beforeTxHoldFired) {
              beforeTxHoldFired = true;
              beforeTxReached?.();
              await new Promise<void>((r) => {
                beforeTxResolver = r;
              });
            }
            return realTransaction(fn);
          }) as unknown as typeof realDb.transaction;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    setTestDb(wrappedDb);

    try {
      // Issue the request with a CURRENT CLI header so the pre-parse
      // version gate passes — we want to exercise the in-tx status
      // check, not the version gate.
      const reqPromise = app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy/upload-urls`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
            'X-Void-CLI-Version': MIN_CLI_VERSION,
          },
          body: JSON.stringify({ assets: [] }),
        }),
        env,
      );
      await beforeTxReachedPromise;

      // Simulate teardown landing AFTER the unlocked early-out check
      // (which saw 'live') but BEFORE the FOR-SHARE acquisition.
      await realDb.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

      beforeTxResolver?.();
      const res = await reqPromise;
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('project is being deleted');
    } finally {
      setTestDb(realDb);
    }
  });
});
