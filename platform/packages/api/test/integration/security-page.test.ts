import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import app from '../../src/index.ts';
import { mintSecurityPageToken } from '../../src/security/page-token.ts';
import { securityFindings } from '../../src/security/schema.ts';
import { clearTables, createTestDeployment, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  insertCompletedScan,
  insertSecurityFinding,
  projectWithRoles,
  saveSecurityPolicy,
  securityOn,
} from './security-fixtures.ts';

let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = securityOn(env);
});

function get(path: string, cookie?: string) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: 'manual',
    }),
    onEnv,
  );
}

function post(path: string, fields: Record<string, string>, cookie: string, origin: string) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
        Origin: origin,
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    }),
    onEnv,
  );
}

async function token(userId: string, projectId: string, now = Date.now()) {
  return (await mintSecurityPageToken({ userId, projectId }, env.JWT_SECRET, now)).token;
}

/** Redeems the link the way a browser does and returns the cookie it keeps. */
async function signIn(userId: string, projectId: string) {
  const redeemed = await get(`/security/projects/acme-web?t=${await token(userId, projectId)}`);
  expect(redeemed.status).toBe(303);
  expect(redeemed.headers.get('location')).toBe('/security/projects/acme-web');
  const cookie = redeemed.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly');
  return cookie.split(';')[0];
}

async function view(cookie: string) {
  const response = await get('/security/projects/acme-web', cookie);
  expect(response.status).toBe(200);
  return response.text();
}

describe('read-only security page', () => {
  it('shows detail to deploy roles and counts only to a reader; a bad link shows nothing', async () => {
    await saveSecurityPolicy(env);
    const { project, people } = await projectWithRoles(env);
    const deployment = await createTestDeployment(env.db, project.id);
    await insertCompletedScan(env, project.id, deployment.id);
    await insertSecurityFinding(env, project.id, { number: 1, severity: 'critical' });

    const owner = await view(await signIn(people.owner.id, project.id));
    expect(owner).toContain('1 urgent finding is open</strong>');
    expect(owner).toContain('SECRET TITLE 1');
    expect(owner).toContain('src/routes/secret-1.ts:41');

    const reader = await view(await signIn(people.reader.id, project.id));
    expect(reader).toContain('1 urgent finding is open</strong>');
    expect(reader).not.toContain('SECRET TITLE');
    expect(reader).not.toContain('<form');

    const expired = await token(people.owner.id, project.id, Date.now() - 16 * 60_000);
    const refused = await get(`/security/projects/acme-web?t=${expired}`);
    expect(refused.status).toBe(400);
    expect(refused.headers.get('set-cookie')).toBeNull();
    const landing = await (await get('/security/projects/acme-web')).text();
    expect(landing).toContain('void project security open --project acme-web');
    expect(landing).not.toContain('SECRET TITLE');
  });

  it('resolves a finding from its form, and refuses a cross-site post', async () => {
    await saveSecurityPolicy(env);
    const { project, people } = await projectWithRoles(env);
    await insertSecurityFinding(env, project.id, { number: 1, severity: 'critical' });
    const cookie = await signIn(people.admin.id, project.id);
    const path = '/security/projects/acme-web/findings/F-1/resolve';
    const form = { reason: 'fixed', comment: 'patched in #12', expectedRevision: '1' };

    expect((await post(path, form, cookie, 'https://evil.example')).status).toBe(403);
    const [open] = await env.db.select().from(securityFindings);
    expect(open.state).toBe('open');

    const response = await post(path, form, cookie, 'http://localhost');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/security/projects/acme-web?done=resolved');
    const [row] = await env.db
      .select()
      .from(securityFindings)
      .where(eq(securityFindings.project_id, project.id));
    expect(row).toMatchObject({ state: 'resolved', resolution: 'fixed', revision: 2 });
  });
});
