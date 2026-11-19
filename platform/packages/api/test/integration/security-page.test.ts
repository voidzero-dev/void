import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
  type SecurityPolicy,
} from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import app from '../../src/index.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import { projectMembers, users } from '../../src/schema.ts';
import { mintSecurityPageToken } from '../../src/security/page-token.ts';
import {
  securityFindings,
  securityProjectSpend,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/security/schema.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
  };
});

async function savePolicy(policy: Partial<SecurityPolicy> = {}) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    revision: 1,
    ...policy,
  });
}

const ROLES = ['owner', 'admin', 'collaborator', 'reader'] as const;
type Role = (typeof ROLES)[number];

async function setup(slug = 'acme-web') {
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  const people: Record<Role, { id: string; login: string; jwt: string }> = {
    owner,
    admin: owner,
    collaborator: owner,
    reader: owner,
  };
  for (const role of ['admin', 'collaborator', 'reader'] as const) {
    const user = await createTestUser(env.db, `${role}-${slug}`);
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: user.id,
      role,
      added_by_user_id: owner.id,
    });
    people[role] = user;
  }
  const outsider = await createTestUser(env.db, `outsider-${slug}`);
  return { owner, project, people, outsider };
}

let counter = 0;

async function addFinding(
  projectId: string,
  overrides: Partial<typeof securityFindings.$inferInsert> = {},
) {
  const n = overrides.number ?? ++counter;
  await env.db.insert(securityFindings).values({
    id: `sf_page${projectId}${n}`,
    project_id: projectId,
    number: n,
    fingerprint_key: `key-${projectId}-${n}`,
    verdict: 'confirmed',
    severity: 'high',
    title: `SECRET TITLE ${n}`,
    category: 'sqli',
    file: `src/routes/secret-${n}.ts`,
    line_start: 41,
    detail: { trace: ['a', 'b'], evidence: 'EVIDENCE', conditions: 'c', fix: 'FIX' },
    sink_path: `src/routes/secret-${n}.ts`,
    sink_content_hash: 'hash-1',
    first_scan_id: 'scan_x',
    last_seen_scan_id: 'scan_x',
    first_deployment_id: 'dpl_first',
    ...overrides,
  });
}

async function addScan(projectId: string, deploymentId: string) {
  await env.db.insert(securityScans).values({
    id: `scan_${projectId}`,
    project_id: projectId,
    deployment_id: deploymentId,
    status: 'succeeded',
    trigger: 'deploy',
    model_used: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    engine: 'void_loop',
    tier: 'built_diff',
    coverage: 'complete',
    files_scanned: 12,
    metered_nano_usd: 2_500_000_000,
    finished_at: new Date().toISOString(),
  });
}

function get(path: string, options: { cookie?: string } = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      headers: options.cookie ? { Cookie: options.cookie } : {},
      redirect: 'manual',
    }),
    onEnv,
  );
}

async function token(userId: string, projectId: string, now = Date.now()) {
  return (await mintSecurityPageToken({ userId, projectId }, env.JWT_SECRET, now)).token;
}

/** Redeems the link the way a browser does and returns the cookie it keeps. */
async function signIn(userId: string, projectId: string, slug = 'acme-web') {
  const redeemed = await get(`/security/projects/${slug}?t=${await token(userId, projectId)}`);
  expect(redeemed.status).toBe(303);
  const setCookie = redeemed.headers.get('set-cookie')!;
  return setCookie.split(';')[0]!;
}

async function view(cookie: string, slug = 'acme-web') {
  const response = await get(`/security/projects/${slug}`, { cookie });
  expect(response.status).toBe(200);
  return response.text();
}

describe('signing in with the link', () => {
  it('swaps the token for a path-scoped cookie and redirects to the clean URL', async () => {
    const { project, people } = await setup();
    const response = await get(
      `/security/projects/acme-web?t=${await token(people.owner.id, project.id)}`,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/security/projects/acme-web');
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('void_security_page=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/security/projects/acme-web');
    expect(cookie).toContain('SameSite=Lax');
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
    expect(maxAge).toBeGreaterThan(14 * 60);
    expect(maxAge).toBeLessThanOrEqual(15 * 60);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('marks the cookie Secure on https', async () => {
    const { project, people } = await setup();
    const response = await app.fetch(
      new Request(
        `https://api.example.com/security/projects/acme-web?t=${await token(people.owner.id, project.id)}`,
        { redirect: 'manual' },
      ),
      onEnv,
    );
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('refuses an expired, cut, foreign or other-project token and sets no cookie', async () => {
    await savePolicy();
    const { project, people } = await setup();
    const other = await setup('other-web');
    await addFinding(project.id);
    const good = await token(people.owner.id, project.id);
    const cases = [
      ['expired', await token(people.owner.id, project.id, Date.now() - 16 * 60_000), 'acme-web'],
      ['cut', good.slice(0, -3), 'acme-web'],
      ['other project', await token(other.people.owner.id, other.project.id), 'acme-web'],
      ['unknown project', good, 'no-such-project'],
    ] as const;
    for (const [name, value, slug] of cases) {
      const response = await get(`/security/projects/${slug}?t=${encodeURIComponent(value)}`);
      expect(response.status, name).toBe(400);
      expect(response.headers.get('set-cookie'), name).toBeNull();
      const html = await response.text();
      expect(html, name).toContain('This link no longer works');
      expect(html, name).not.toContain('SECRET TITLE');
    }
  });
});

describe('without a valid sign-in', () => {
  it('shows the landing page with no project data', async () => {
    await savePolicy();
    const { project, people } = await setup();
    await addFinding(project.id);
    const forged = (await token(people.owner.id, project.id)).split('.')[0] + '.AAAA';
    for (const cookie of [
      undefined,
      'void_security_page=garbage',
      `void_security_page=${forged}`,
    ]) {
      const response = await get('/security/projects/acme-web', cookie ? { cookie } : {});
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const html = await response.text();
      expect(html).toContain('void project security open --project acme-web');
      expect(html).not.toContain('SECRET TITLE');
      expect(html).not.toContain('urgent');
    }
  });

  it('answers an unknown project like a known one, without data', async () => {
    const known = await (await get('/security/projects/acme-web')).text();
    await setup();
    const known2 = await (await get('/security/projects/acme-web')).text();
    const unknown = await (await get('/security/projects/nope')).text();
    expect(known2).toBe(known);
    expect(unknown).toContain('void project security open --project nope');
  });

  it('does not accept a cookie from another project', async () => {
    const a = await setup('acme-web');
    const b = await setup('other-web');
    await addFinding(b.project.id);
    const cookie = await signIn(a.people.owner.id, a.project.id);
    const response = await get('/security/projects/other-web', { cookie });
    expect(await response.text()).not.toContain('SECRET TITLE');
  });

  it('shows the landing page to a user with no role, and after the member is removed', async () => {
    await savePolicy();
    const { project, people, outsider } = await setup();
    await addFinding(project.id);
    const outsiderCookie = await signIn(outsider.id, project.id);
    expect(await view(outsiderCookie)).not.toContain('SECRET TITLE');

    const readerCookie = await signIn(people.reader.id, project.id);
    expect(await view(readerCookie)).toContain('Open findings');
    await env.db.delete(projectMembers).where(eq(projectMembers.user_id, people.reader.id));
    const html = await view(readerCookie);
    expect(html).toContain('void project security open --project acme-web');
    expect(html).not.toContain('Open findings');
  });

  it('shows the landing page when the cookie is older than 15 minutes', async () => {
    const { project, people } = await setup();
    const old = await token(people.owner.id, project.id, Date.now() - 20 * 60_000);
    const html = await view(`void_security_page=${old}`);
    expect(html).toContain('void project security open');
    expect(html).not.toContain('· Security');
  });
});

describe('what each role sees', () => {
  async function populate() {
    await savePolicy({ mode: 'all' });
    const world = await setup();
    const deployment = await createTestDeployment(env.db, world.project.id);
    await addScan(world.project.id, deployment.id);
    await addFinding(world.project.id, { number: 1, severity: 'critical' });
    await addFinding(world.project.id, { number: 2, severity: 'medium' });
    await addFinding(world.project.id, { number: 3, verdict: 'needs_validation', severity: null });
    await addFinding(world.project.id, {
      number: 4,
      state: 'resolved',
      resolution: 'false_positive',
      resolved_at: new Date().toISOString(),
      title: 'RESOLVED TITLE',
      file: 'src/resolved-file.ts',
    });
    await env.db.insert(securityProjectSpend).values({
      project_id: world.project.id,
      month: `${new Date().toISOString().slice(0, 7)}-01`,
      spent_nano_usd: 4_000_000_000,
    });
    return world;
  }

  it('shows owners and admins everything with the resolve and budget commands', async () => {
    const { project, people } = await populate();
    for (const role of ['owner', 'admin'] as const) {
      const html = await view(await signIn(people[role].id, project.id));
      expect(html, role).toContain('acme-web · Security');
      expect(html, role).toContain('1 urgent finding is open</strong>');
      expect(html, role).toContain('SECRET TITLE 1');
      expect(html, role).toContain('src/routes/secret-1.ts:41');
      expect(html, role).toContain('EVIDENCE');
      expect(html, role).toContain('RESOLVED TITLE');
      expect(html, role).toContain('void project security resolve F-1 --reason fixed');
      expect(html, role).toContain('void project security budget --usd');
      expect(html, role).toContain('$4.00');
      expect(html, role).toContain('<h2>Scans</h2>');
      expect(html, role).not.toContain('A project admin or owner can resolve these.</p><pre>');
    }
  });

  it('shows a collaborator the detail but not the resolve command', async () => {
    const { project, people } = await populate();
    const html = await view(await signIn(people.collaborator.id, project.id));
    expect(html).toContain('SECRET TITLE 1');
    expect(html).toContain('EVIDENCE');
    expect(html).toContain('A project admin or owner can resolve these.');
    expect(html).toContain('void project security comment F-1 ');
    expect(html).not.toContain('security resolve');
    expect(html).not.toContain('security budget');
  });

  it('shows a reader counts and ids only', async () => {
    const { project, people } = await populate();
    const html = await view(await signIn(people.reader.id, project.id));
    expect(html).toContain('1 urgent finding is open</strong>');
    expect(html).toContain('Urgent 1 · critical 1');
    expect(html).toContain('F-1, F-2, F-3');
    expect(html).toContain('RESOLVED TITLE');
    for (const hidden of [
      'SECRET TITLE',
      'secret-1.ts',
      'src/resolved-file.ts',
      'EVIDENCE',
      'Budget',
      '$4.00',
      '<h2>Scans</h2>',
      'security resolve',
      'deepseek',
    ]) {
      expect(html, hidden).not.toContain(hidden);
    }
  });

  it('escapes model text and shows no markup from a finding', async () => {
    await savePolicy();
    const { project, people } = await setup();
    await addFinding(project.id, {
      number: 1,
      title: '<script>alert(1)</script> <img src=x onerror=1>',
      detail: { trace: ['<b>x</b>'], evidence: '</pre><script>1</script>', fix: '[a](http://e)' },
    });
    const html = await view(await signIn(people.owner.id, project.id));
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('</pre><script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('[a](http://e)');
  });

  it('says so when security audits are off', async () => {
    await savePolicy({ mode: 'disabled' });
    const { project, people } = await setup();
    await addFinding(project.id);
    const html = await view(await signIn(people.owner.id, project.id));
    expect(html).toContain('Security audits are off on this platform.');
    expect(html).not.toContain('SECRET TITLE');
  });

  it('says there is no scan yet and reports a clean project', async () => {
    await savePolicy();
    const { project, people } = await setup();
    expect(await view(await signIn(people.owner.id, project.id))).toContain(
      'No scan yet. The first scan runs after your next deploy and reviews the whole app.',
    );
    const deployment = await createTestDeployment(env.db, project.id);
    await addScan(project.id, deployment.id);
    expect(await view(await signIn(people.owner.id, project.id))).toContain(
      '✓ No open findings. Last scan:',
    );
  });
});

describe('public request and bypass', () => {
  async function request(
    projectId: string,
    userId: string,
    state: 'waiting_scan' | 'held_findings' | 'held_no_result',
    blockerIds: Array<string> = [],
  ) {
    const deployment = await createTestDeployment(env.db, projectId);
    await env.db.insert(securityPublicRequests).values({
      id: `spr_${projectId}`,
      project_id: projectId,
      state,
      held_reason: state === 'held_no_result' ? 'refused' : null,
      requested_by_user_id: userId,
      requested_via: 'project',
      target_deployment_id: deployment.id,
      blockers: blockerIds.length,
      blocker_ids: blockerIds,
    });
    return deployment;
  }

  it('shows the bypass command only when a scan result is missing and no urgent finding is open', async () => {
    await savePolicy({ mode: 'public', publicGate: true });
    const { project, people } = await setup();
    await request(project.id, people.owner.id, 'held_no_result');
    const admin = await signIn(people.admin.id, project.id);
    const html = await view(admin);
    expect(html).toContain('Stays protected: the security scan did not finish (refused)');
    expect(html).toContain('Asked by the project owner on');
    expect(html).toContain('void project zero-trust bypass --reason');
    const reader = await view(await signIn(people.reader.id, project.id));
    expect(reader).toContain('A project admin or owner can bypass the scan.');
    expect(reader).not.toContain('zero-trust bypass');
    const collaborator = await view(await signIn(people.collaborator.id, project.id));
    expect(collaborator).toContain('A project admin or owner can bypass the scan.');
    expect(collaborator).not.toContain('zero-trust bypass');
  });

  it('never offers a bypass while urgent findings hold the request', async () => {
    await savePolicy({ mode: 'public', publicGate: true });
    const { project, people } = await setup();
    await addFinding(project.id, { number: 1, severity: 'critical' });
    await request(project.id, people.owner.id, 'held_findings', ['F-1']);
    const html = await view(await signIn(people.owner.id, project.id));
    expect(html).toContain(
      '1 urgent finding must be resolved before Zero Trust is turned off (F-1)',
    );
    expect(html).toContain('void project security resolve F-1');
    expect(html).not.toContain('zero-trust bypass');
  });

  it('shows bypass history with the reason to deploy roles and without it to readers', async () => {
    await savePolicy();
    const { project, people } = await setup();
    const deployment = await request(project.id, people.owner.id, 'waiting_scan');
    await env.db.insert(securityScanBypasses).values({
      id: 'ssb_1',
      project_id: project.id,
      request_id: `spr_${project.id}`,
      deployment_id: deployment.id,
      actor_kind: 'user',
      actor_user_id: people.admin.id,
      actor_role: 'admin',
      reason: 'ship it <b>now</b>',
      request_state: 'waiting_scan',
    });
    const collaborator = await view(await signIn(people.collaborator.id, project.id));
    expect(collaborator).toContain('Bypassed 1 time:');
    expect(collaborator).toContain(
      'by a project admin (&quot;ship it &lt;b&gt;now&lt;/b&gt;&quot;)',
    );
    const reader = await view(await signIn(people.reader.id, project.id));
    expect(reader).toContain('Bypassed 1 time');
    expect(reader).not.toContain('ship it');
  });
});

describe('accounts and large projects', () => {
  it('shows the landing page for a suspended account, a suspended owner, and a deleted account', async () => {
    await savePolicy();
    const { project, owner, people } = await setup();
    await addFinding(project.id);
    const readerCookie = await signIn(people.reader.id, project.id);
    const ownerCookie = await signIn(owner.id, project.id);
    expect(await view(readerCookie)).toContain('Open findings');

    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, people.reader.id));
    const suspended = await view(readerCookie);
    expect(suspended).toContain('void project security open');
    expect(suspended).not.toContain('Open findings');

    // The owner is suspended: the API refuses every member, so the page does too.
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, owner.id));
    for (const cookie of [ownerCookie, await signIn(people.admin.id, project.id)]) {
      const html = await view(cookie);
      expect(html).toContain('void project security open');
      expect(html).not.toContain('SECRET TITLE');
    }
    // Usage-limit suspension is not an admin action and keeps access.
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, owner.id));
    expect(await view(ownerCookie)).toContain('SECRET TITLE');

    await env.db.delete(projectMembers).where(eq(projectMembers.user_id, people.collaborator.id));
    const goneCookie = await signIn(people.admin.id, project.id);
    await env.db.delete(projectMembers).where(eq(projectMembers.user_id, people.admin.id));
    await env.db.delete(users).where(eq(users.id, people.admin.id));
    const gone = await view(goneCookie);
    expect(gone).toContain('void project security open');
    expect(gone).not.toContain('SECRET TITLE');
  });

  it('tells a collaborator once that an admin or owner resolves held findings', async () => {
    await savePolicy();
    const { project, people } = await setup();
    await addFinding(project.id, { number: 1 });
    const deployment = await createTestDeployment(env.db, project.id);
    await env.db.insert(securityPublicRequests).values({
      id: `spr_${project.id}`,
      project_id: project.id,
      state: 'held_findings',
      requested_by_user_id: people.owner.id,
      requested_via: 'project',
      target_deployment_id: deployment.id,
      blockers: 1,
      blocker_ids: ['F-1'],
    });
    const html = await view(await signIn(people.collaborator.id, project.id));
    expect(html.split('A project admin or owner can resolve these.').length - 1).toBe(1);
  });

  it('answers an empty ?t= as an expired link', async () => {
    await savePolicy();
    const { project } = await setup();
    await addFinding(project.id);
    const response = await get('/security/projects/acme-web?t=');
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
    const html = await response.text();
    expect(html).toContain('This link no longer works');
    expect(html).not.toContain('SECRET TITLE');
  });

  it('keeps an urgent finding past the first 100 open ones and states the true totals', async () => {
    await savePolicy();
    const { project, people } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    await addScan(project.id, deployment.id);
    for (let n = 1; n <= 101; n++) {
      await addFinding(project.id, { number: n, severity: 'low', title: `LOW TITLE ${n}` });
    }
    await addFinding(project.id, { number: 102, severity: 'critical', title: 'LATE URGENT' });
    for (let n = 103; n <= 104; n++) {
      await addFinding(project.id, {
        number: n,
        state: 'resolved',
        resolution: 'fixed',
        resolved_at: new Date().toISOString(),
        title: `DONE ${n}`,
      });
    }

    const owner = await view(await signIn(people.owner.id, project.id));
    expect(owner).toContain('LATE URGENT');
    expect(owner).toContain('1 urgent finding is');
    expect(owner).toContain('void project security resolve F-102 --reason fixed');
    expect(owner).toContain('Other open: 101');
    expect(owner).toContain('Resolved: 2');
    expect(owner).toContain(
      'Showing 100 of 101. See the rest with: void project security findings',
    );

    const reader = await view(await signIn(people.reader.id, project.id));
    expect(reader).toContain('F-102');
    expect(reader).toContain('Showing 101 of 102.');
  });
});
