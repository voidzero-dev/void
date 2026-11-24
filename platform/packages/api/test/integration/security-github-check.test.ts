/**
 * The `Void Security Audit` GitHub check (design doc 0095 M28, spec §11.3): a `neutral`
 * check run with counts and the landing link at ingest, a counts-only PR comment, and
 * `check_run:rerequested` → project rescan for a sender who could ask for one.
 */
import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { createGitHubConnection, upsertGitHubInstallation } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { getInstallationToken } from '../../src/github/installation-token.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import { requireProjectCapability } from '../../src/project-access.ts';
import { webhookRoutes } from '../../src/routes/webhooks.ts';
import {
  builds,
  deployments,
  githubConnections,
  githubInstallations,
  projectMembers,
  projects,
  users,
} from '../../src/schema.ts';
import { securityScanInputPrefix } from '../../src/security/enqueue.ts';
import {
  handleSecurityCheckRerequest,
  reportSecurityScanToGitHub,
  securityGitHubCheckCopy,
  securityPullRequestComment,
  VOID_SECURITY_AUDIT_CHECK_RUN_NAME,
} from '../../src/security/github-check.ts';
import { securityFindings, securityScans } from '../../src/security/schema.ts';
import {
  clearTables,
  createTestBuild,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

vi.mock('../../src/project-access.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/project-access.ts')>();
  return { ...actual, requireProjectCapability: vi.fn(actual.requireProjectCapability) };
});

vi.mock('../../src/github/installation-token.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/github/installation-token.ts')>()),
  getInstallationToken: vi.fn(async () => 'app-token'),
}));

const HEAD = 'c'.repeat(40);
const REPO = 'acme/web';
const API = 'https://api.github.com';
const WEBHOOK_SECRET = 'security-check-webhook-secret';

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
      managedBuilds: true,
      securityAudits: true,
    }),
    GITHUB_APP_ID: '1234',
    GITHUB_APP_PRIVATE_KEY: 'unused: the token mint is mocked',
    AUTH_REDIRECT_URI: 'https://api.example.test/auth/callback',
    SECURITY_SCAN_SCHEDULER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
  } as unknown as TestEnv;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(getInstallationToken).mockReset();
  vi.mocked(getInstallationToken).mockImplementation(async () => 'app-token');
});

type Call = { method: string; url: string; body: unknown };
type StubComment = {
  id: number;
  body: string;
  user: { type: string; login?: string };
  performed_via_github_app?: { id: number } | null;
};

/** A comment our App (id 1234 in `onEnv`) wrote. */
function ours(id: number, body: string): StubComment {
  return { id, body, user: { type: 'Bot' }, performed_via_github_app: { id: 1234 } };
}

/** GitHub stand-in: check runs, the commit's pull requests and their comments. */
function stubGithub(
  options: {
    pulls?: Array<{ number: number; state: string; head: { sha: string } }>;
    /** Comments of each pull request, split into pages of 100 as GitHub does. */
    comments?: Record<number, Array<StubComment>>;
    /** A non-ok answer to every comment list read. */
    commentListStatus?: number;
    createStatus?: number;
  } = {},
) {
  const calls: Array<Call> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      if (method === 'POST' && url === `${API}/repos/${REPO}/check-runs`) {
        return options.createStatus
          ? new Response('nope', { status: options.createStatus })
          : Response.json({ id: 777 }, { status: 201 });
      }
      if (method === 'PATCH' && url === `${API}/repos/${REPO}/check-runs/777`) {
        return Response.json({ id: 777 });
      }
      if (url === `${API}/repos/${REPO}/commits/${HEAD}/pulls?per_page=30`) {
        return Response.json(options.pulls ?? []);
      }
      const listPrefix = `${API}/repos/${REPO}/issues/`;
      const listMiddle = '/comments?per_page=100&page=';
      if (method === 'GET' && url.startsWith(listPrefix) && url.includes(listMiddle)) {
        if (options.commentListStatus) {
          return new Response('nope', { status: options.commentListStatus });
        }
        const rest = url.slice(listPrefix.length);
        const pull = Number(rest.slice(0, rest.indexOf(listMiddle)));
        const page = Number(rest.slice(rest.indexOf(listMiddle) + listMiddle.length));
        return Response.json((options.comments?.[pull] ?? []).slice((page - 1) * 100, page * 100));
      }
      if (method === 'POST' && url.includes('/issues/') && url.endsWith('/comments')) {
        return Response.json({ id: 900 }, { status: 201 });
      }
      if (method === 'PATCH' && url.includes('/issues/comments/')) {
        return Response.json({ id: 900 });
      }
      return new Response('not stubbed', { status: 404 });
    }),
  );
  return calls;
}

async function savePolicy() {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    revision: 1,
  });
}

/** A project connected to `acme/web`, live on a container build of `HEAD`. */
async function connectedProject(
  options: { executor?: 'container' | 'github_actions'; deployCommit?: string | null } = {},
) {
  const slug = `web-${crypto.randomUUID().slice(0, 8)}`;
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  await upsertGitHubInstallation(env.db, {
    installationId: '900',
    userId: null,
    accountLogin: 'acme',
    accountId: '900',
    accountType: 'Organization',
    repositories: [],
    repositorySelection: 'all',
  });
  await createGitHubConnection(env.db, {
    projectId: project.id,
    installationId: '900',
    repoFullName: REPO,
    repositoryId: '9001',
    authorizedByUserId: owner.id,
    buildExecutor: options.executor ?? 'container',
  });
  const deployment = await createTestDeployment(env.db, project.id, 'live', undefined, undefined, {
    commit: options.deployCommit === undefined ? HEAD : options.deployCommit,
  });
  const build = await createTestBuild(env.db, {
    projectId: project.id,
    userId: owner.id,
    executor: options.executor ?? 'container',
    commitSha: HEAD,
    branch: 'main',
    status: 'complete',
  });
  await env.db.update(builds).set({ deployment_id: deployment.id }).where(eq(builds.id, build.id));
  await env.db
    .update(deployments)
    .set({ bundle_stored: true })
    .where(eq(deployments.id, deployment.id));
  await env.STATIC_ASSETS_R2.put(
    `${securityScanInputPrefix(project.id, deployment.id)}modules.json`,
    '[]',
  );
  return { owner, project, deployment };
}

async function endedScan(
  projectId: string,
  deploymentId: string,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  const id = `ss_${crypto.randomUUID().slice(0, 8)}`;
  await env.db.insert(securityScans).values({
    status: 'succeeded',
    trigger: 'deploy',
    tier: 'built_diff',
    finished_at: new Date().toISOString(),
    ...overrides,
    id,
    project_id: projectId,
    deployment_id: deploymentId,
  });
  return id;
}

async function finding(
  projectId: string,
  number: number,
  overrides: Partial<typeof securityFindings.$inferInsert> = {},
) {
  await env.db.insert(securityFindings).values({
    id: `sf_${projectId}_${number}`,
    project_id: projectId,
    number,
    fingerprint_key: `fp-${number}`,
    verdict: 'confirmed',
    severity: 'critical',
    title: 'SQL built from the request query',
    category: 'sqli',
    file: 'src/routes/search.ts',
    line_start: 3,
    first_scan_id: 'ss_x',
    last_seen_scan_id: 'ss_x',
    ...overrides,
  });
}

/** The report needs the whole Worker env type; the test env carries what it reads. */
function report(scanId: string, bindings: TestEnv = onEnv) {
  return reportSecurityScanToGitHub(bindings as unknown as ApiEnv['Bindings'], env.db, scanId);
}

describe('securityGitHubCheckCopy', () => {
  const base = { slug: 'acme-web', statusReason: null, landingUrl: null } as const;

  it('says the spec copy with counts only', () => {
    expect(
      securityGitHubCheckCopy({ ...base, status: 'succeeded', counts: { critical: 1, high: 1 } }),
    ).toEqual({
      title: '2 urgent security findings (1 critical, 1 high)',
      summary:
        '2 urgent security findings are open in acme-web (1 critical, 1 high). Deploys are not affected. Review: void project security open --project acme-web',
    });
    expect(
      securityGitHubCheckCopy({ ...base, status: 'succeeded', counts: { critical: 0, high: 0 } })
        .title,
    ).toBe('No urgent security findings');
    expect(
      securityGitHubCheckCopy({ ...base, status: 'succeeded', counts: { critical: 0, high: 1 } })
        .title,
    ).toBe('1 urgent security finding (1 high)');
  });

  it('never calls an unfinished scan clean', () => {
    const refused = securityGitHubCheckCopy({
      ...base,
      status: 'refused',
      counts: { critical: 0, high: 0 },
    });
    expect(refused.title).toBe('Security scan did not finish (refused)');
    expect(
      refused.summary.startsWith('The security scan of this commit did not finish (refused).'),
    ).toBe(true);
    expect(
      securityGitHubCheckCopy({
        ...base,
        status: 'failed',
        statusReason: 'bad_output',
        counts: { critical: 0, high: 0 },
      }).title,
    ).toBe('Security scan did not finish (bad output)');
    expect(
      securityGitHubCheckCopy({ ...base, status: 'incomplete', counts: { critical: 0, high: 0 } })
        .summary,
    ).toContain('did not cover everything (incomplete)');
  });

  it('keeps platform-side failure reasons out of the public check', () => {
    for (const statusReason of ['credits', 'infrastructure', null]) {
      const copy = securityGitHubCheckCopy({
        ...base,
        status: 'failed',
        statusReason,
        counts: { critical: 0, high: 0 },
      });
      expect(copy.title).toBe('Security scan did not finish');
      expect(copy.summary.startsWith('The security scan of this commit did not finish.')).toBe(
        true,
      );
    }
    expect(
      securityGitHubCheckCopy({
        ...base,
        status: 'failed',
        statusReason: 'input_missing',
        counts: { critical: 0, high: 0 },
      }).title,
    ).toBe('Security scan did not finish (input missing)');
  });

  it('puts the landing link in the summary and the PR comment', () => {
    const url = 'https://api.example.test/security/projects/acme-web';
    expect(
      securityGitHubCheckCopy({
        ...base,
        landingUrl: url,
        status: 'succeeded',
        counts: { critical: 1, high: 0 },
      }).summary.endsWith(`\n\n${url}`),
    ).toBe(true);
    const comment = securityPullRequestComment({
      projectId: 'proj_1',
      slug: 'acme-web',
      counts: { critical: 1, high: 0 },
      landingUrl: url,
    });
    expect(comment.startsWith('<!-- void-security-audit:proj_1 -->')).toBe(true);
    expect(comment).toContain('1 urgent security finding is open in acme-web (1 critical)');
    expect(comment).toContain(url);
  });
});

describe('reportSecurityScanToGitHub', () => {
  it('creates the check on the build commit and completes it neutral, counts only', async () => {
    const { project, deployment } = await connectedProject();
    await finding(project.id, 1);
    await finding(project.id, 2, { severity: 'high' });
    // Not urgent: a lead, a resolved finding, a medium.
    await finding(project.id, 3, { verdict: 'needs_validation' });
    await finding(project.id, 4, {
      state: 'resolved',
      resolution: 'fixed',
      resolved_at: new Date().toISOString(),
    });
    await finding(project.id, 5, { severity: 'medium' });
    const scanId = await endedScan(project.id, deployment.id);
    const calls = stubGithub();

    const result = await report(scanId);

    expect(result).toEqual({ reported: true, checkRunId: '777', comments: 0 });
    const create = calls.find((call) => call.url === `${API}/repos/${REPO}/check-runs`)!;
    expect(create.body).toMatchObject({
      name: VOID_SECURITY_AUDIT_CHECK_RUN_NAME,
      head_sha: HEAD,
      external_id: scanId,
      details_url: `https://api.example.test/security/projects/${project.slug}`,
    });
    const complete = calls.find((call) => call.method === 'PATCH')!;
    expect(complete.body).toMatchObject({
      status: 'completed',
      conclusion: 'neutral',
      output: { title: '2 urgent security findings (1 critical, 1 high)' },
    });
    // Public repos show check runs to anyone: no title, file or line.
    const text = JSON.stringify(calls.map((call) => call.body));
    expect(text).not.toContain('SQL built');
    expect(text).not.toContain('src/routes/search.ts');
  });

  it('stays neutral and says so when the scan did not finish', async () => {
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id, {
      status: 'timed_out',
      failure_cause: 'project',
    });
    const calls = stubGithub();

    await report(scanId);

    const complete = calls.find((call) => call.method === 'PATCH')!;
    expect(complete.body).toMatchObject({
      conclusion: 'neutral',
      output: { title: 'Security scan did not finish (timed out)' },
    });
  });

  it('sends nothing on a self-hosted install (no managedBuilds)', async () => {
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    const calls = stubGithub();
    const selfHosted = {
      ...onEnv,
      PLATFORM_CAPABILITIES: JSON.stringify({
        ...getPlatformCapabilities(env),
        managedBuilds: false,
        securityAudits: true,
      }),
    };

    expect(await report(scanId, selfHosted)).toEqual({
      reported: false,
      reason: 'not hosted',
    });
    expect(calls).toEqual([]);
  });

  it('sends nothing for a deploy without a platform build, or one that claims another commit', async () => {
    const { project, deployment } = await connectedProject();
    await env.db.delete(builds).where(eq(builds.project_id, project.id));
    const noBuild = await endedScan(project.id, deployment.id);
    const other = await connectedProject({
      executor: 'github_actions',
      deployCommit: 'd'.repeat(40),
    });
    const mismatch = await endedScan(other.project.id, other.deployment.id);
    const calls = stubGithub();

    expect(await report(noBuild)).toEqual({
      reported: false,
      reason: 'no GitHub build',
    });
    expect(await report(mismatch)).toEqual({
      reported: false,
      reason: 'no GitHub build',
    });
    expect(calls).toEqual([]);
  });

  it('sends nothing for a build older than the project connection (reconnected repo)', async () => {
    const { project, deployment } = await connectedProject();
    // The project was reconnected after this build: the build may be from another repo.
    await env.db
      .update(builds)
      .set({ created_at: '2020-01-01 00:00:00' })
      .where(eq(builds.project_id, project.id));
    const scanId = await endedScan(project.id, deployment.id);
    const calls = stubGithub();

    expect(await report(scanId)).toEqual({ reported: false, reason: 'no GitHub build' });
    expect(calls).toEqual([]);
  });

  it('skips scans that did not run', async () => {
    const { project, deployment } = await connectedProject();
    const skipped = await endedScan(project.id, deployment.id, {
      status: 'skipped',
      status_reason: 'budget',
    });
    const calls = stubGithub();

    expect(await report(skipped)).toEqual({
      reported: false,
      reason: 'not ended',
    });
    expect(calls).toEqual([]);
  });

  it('never throws when GitHub refuses the check', async () => {
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    const calls = stubGithub({ createStatus: 422 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await report(scanId)).toEqual({
      reported: true,
      checkRunId: null,
      comments: 0,
    });
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});

describe('PR comment', () => {
  const pulls = [
    { number: 12, state: 'open', head: { sha: HEAD } },
    { number: 9, state: 'closed', head: { sha: HEAD } },
    { number: 13, state: 'open', head: { sha: 'e'.repeat(40) } },
  ];

  it('posts one counts-only comment on the open PR whose head is the commit', async () => {
    const { project, deployment } = await connectedProject();
    await finding(project.id, 1);
    const scanId = await endedScan(project.id, deployment.id);
    const calls = stubGithub({ pulls });

    const result = await report(scanId);

    expect(result).toMatchObject({ reported: true, comments: 1 });
    const posted = calls.filter((call) => call.method === 'POST' && call.url.includes('/issues/'));
    expect(posted.map((call) => call.url)).toEqual([`${API}/repos/${REPO}/issues/12/comments`]);
    const body = (posted[0].body as { body: string }).body;
    expect(body).toContain(`<!-- void-security-audit:${project.id} -->`);
    expect(body).toContain('1 urgent security finding is open');
    expect(body).not.toContain('SQL built');
    // The comment token is scoped to this repository and pull requests only.
    expect(vi.mocked(getInstallationToken)).toHaveBeenCalledWith(expect.anything(), '900', {
      repositoryIds: ['9001'],
      permissions: { pull_requests: 'write' },
    });
  });

  it('edits its earlier comment in place, and adds none while nothing is urgent', async () => {
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    const marker = `<!-- void-security-audit:${project.id} -->`;
    const calls = stubGithub({
      pulls: [...pulls, { number: 14, state: 'open', head: { sha: HEAD } }],
      comments: {
        12: [
          { id: 1, body: `${marker} pasted by a person`, user: { type: 'User' } },
          ours(555, `${marker}\n\nold`),
        ],
      },
    });

    const result = await report(scanId);

    expect(result).toMatchObject({ comments: 1 });
    const writes = calls.filter((call) => call.method !== 'GET' && call.url.includes('/issues/'));
    expect(writes.map((call) => `${call.method} ${call.url}`)).toEqual([
      `PATCH ${API}/repos/${REPO}/issues/comments/555`,
    ]);
    expect((writes[0].body as { body: string }).body).toContain(
      'No urgent security findings are open',
    );
  });

  it('posts nothing on a PR whose comments cannot be read, or not all of them', async () => {
    const { project, deployment } = await connectedProject();
    await finding(project.id, 1);
    const scanId = await endedScan(project.id, deployment.id);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const isWrite = (call: Call) => call.method !== 'GET' && call.url.includes('/issues/');

    for (const commentListStatus of [500, 403]) {
      const calls = stubGithub({ pulls, commentListStatus });
      expect(await report(scanId)).toMatchObject({ reported: true, comments: 0 });
      expect(calls.filter(isWrite)).toEqual([]);
    }

    // More than the 3 pages we read: our comment may be on page 4.
    const others = Array.from({ length: 300 }, (_, i) => ({
      id: i + 1,
      body: 'looks good',
      user: { type: 'User' },
    }));
    const calls = stubGithub({ pulls, comments: { 12: others } });
    expect(await report(scanId)).toMatchObject({ reported: true, comments: 0 });
    expect(calls.filter((call) => call.url.includes('/issues/12/comments?')).length).toBe(3);
    expect(calls.filter(isWrite)).toEqual([]);
  });

  it('finds its comment on a later page', async () => {
    const { project, deployment } = await connectedProject();
    await finding(project.id, 1);
    const scanId = await endedScan(project.id, deployment.id);
    const marker = `<!-- void-security-audit:${project.id} -->`;
    const others = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      body: 'looks good',
      user: { type: 'User' },
    }));
    const calls = stubGithub({ pulls, comments: { 12: [...others, ours(555, marker)] } });

    expect(await report(scanId)).toMatchObject({ comments: 1 });
    const writes = calls.filter((call) => call.method !== 'GET' && call.url.includes('/issues/'));
    expect(writes.map((call) => `${call.method} ${call.url}`)).toEqual([
      `PATCH ${API}/repos/${REPO}/issues/comments/555`,
    ]);
  });

  it('does not take a comment another bot wrote with our marker as its own', async () => {
    const { project, deployment } = await connectedProject();
    await finding(project.id, 1);
    const scanId = await endedScan(project.id, deployment.id);
    const marker = `<!-- void-security-audit:${project.id} -->`;
    const calls = stubGithub({
      pulls,
      comments: {
        12: [
          { id: 1, body: marker, user: { type: 'Bot' }, performed_via_github_app: { id: 99 } },
          { id: 2, body: marker, user: { type: 'Bot', login: 'github-actions[bot]' } },
        ],
      },
    });

    expect(await report(scanId)).toMatchObject({ comments: 1 });
    const writes = calls.filter((call) => call.method !== 'GET' && call.url.includes('/issues/'));
    expect(writes.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${API}/repos/${REPO}/issues/12/comments`,
    ]);
  });

  it('knows its comment by the App slug when GitHub does not name the App', async () => {
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    const marker = `<!-- void-security-audit:${project.id} -->`;
    const calls = stubGithub({
      pulls,
      comments: { 12: [{ id: 556, body: marker, user: { type: 'Bot', login: 'void-app[bot]' } }] },
    });

    expect(
      await report(scanId, { ...onEnv, GITHUB_APP_SLUG: 'void-app' } as TestEnv),
    ).toMatchObject({
      comments: 1,
    });
    expect(
      calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/comments/556')),
    ).toBe(true);
  });

  it('sends no comment when the App has no pull request write permission', async () => {
    const { project, deployment } = await connectedProject();
    await finding(project.id, 1);
    const scanId = await endedScan(project.id, deployment.id);
    vi.mocked(getInstallationToken).mockImplementation(async (_env, _id, scope) => {
      if (scope?.permissions?.pull_requests) {
        throw new Error('422 permissions');
      }
      return 'app-token';
    });
    const calls = stubGithub({ pulls });

    const result = await report(scanId);

    expect(result).toEqual({ reported: true, checkRunId: '777', comments: 0 });
    expect(calls.some((call) => call.url.includes('/pulls') || call.url.includes('/issues/'))).toBe(
      false,
    );
  });
});

describe('check_run:rerequested for the security check', () => {
  function app(): Hono<ApiEnv> {
    const hono = new Hono<ApiEnv>();
    hono.use('*', async (context, next) => {
      context.set('db', env.db);
      await next();
    });
    hono.route('/webhooks', webhookRoutes);
    return hono;
  }

  async function sign(body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  async function rerequest(
    scanId: string,
    senderId: number,
    where: { installationId?: number; repositoryId?: number } = {},
  ) {
    const body = JSON.stringify({
      action: 'rerequested',
      installation: { id: where.installationId ?? 900 },
      repository: { full_name: REPO, id: where.repositoryId ?? 9001 },
      sender: { id: senderId },
      check_run: {
        id: 777,
        name: VOID_SECURITY_AUDIT_CHECK_RUN_NAME,
        head_sha: HEAD,
        external_id: scanId,
        conclusion: 'neutral',
      },
    });
    const res = await app().fetch(
      new Request('http://localhost/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'check_run',
          'X-Hub-Signature-256': await sign(body),
        },
        body,
      }),
      { ...onEnv, GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET },
    );
    expect(res.status).toBe(200);
    return await res.json<Record<string, unknown>>();
  }

  async function member(projectId: string, role: 'admin' | 'collaborator', githubId: string) {
    const user = await createTestUser(env.db, `member-${githubId}`, 'github', githubId);
    const [owner] = await env.db
      .select({ user_id: projects.user_id })
      .from(projects)
      .where(eq(projects.id, projectId));
    await env.db.insert(projectMembers).values({
      project_id: projectId,
      user_id: user.id,
      role,
      added_by_user_id: owner.user_id,
    });
    return user;
  }

  async function rescans(projectId: string) {
    return env.db
      .select({ id: securityScans.id, deploymentId: securityScans.deployment_id })
      .from(securityScans)
      .where(and(eq(securityScans.project_id, projectId), eq(securityScans.trigger, 'rescan')));
  }

  it('queues a project rescan for a project admin signed in with that GitHub account', async () => {
    await savePolicy();
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    await member(project.id, 'admin', '4242');
    const calls = stubGithub();

    const json = await rerequest(scanId, 4242);

    const queued = await rescans(project.id);
    expect(json).toEqual({ ok: true, queued: queued[0].id });
    expect(queued).toEqual([{ id: queued[0].id, deploymentId: deployment.id }]);
    // Nothing is written to GitHub until that scan ends.
    expect(calls).toEqual([]);
  });

  it('is a no-op for a sender who cannot rescan', async () => {
    await savePolicy();
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    await member(project.id, 'collaborator', '4243');
    const calls = stubGithub();

    expect(await rerequest(scanId, 4243)).toEqual({ ok: true, ignored: 'sender cannot rescan' });
    // No Void account for this GitHub user at all.
    expect(await rerequest(scanId, 999_999)).toEqual({ ok: true, ignored: 'sender cannot rescan' });
    expect(await rescans(project.id)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('is a no-op when the installation or repository is not the project connection', async () => {
    await savePolicy();
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    await member(project.id, 'admin', '4247');
    const calls = stubGithub();
    const notConnected = { ok: true, ignored: 'repository is not connected to the project' };

    expect(await rerequest(scanId, 4247, { installationId: 901 })).toEqual(notConnected);
    expect(await rerequest(scanId, 4247, { repositoryId: 9002 })).toEqual(notConnected);
    // The installation no longer covers the repository.
    await env.db
      .update(githubInstallations)
      .set({ status: 'suspended' })
      .where(eq(githubInstallations.installation_id, '900'));
    expect(await rerequest(scanId, 4247)).toEqual(notConnected);
    expect(await env.db.select().from(githubConnections)).toHaveLength(1);
    expect(await rescans(project.id)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('is a no-op for a sender an administrator suspended', async () => {
    await savePolicy();
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    const admin = await member(project.id, 'admin', '4248');
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, admin.id));

    expect(await rerequest(scanId, 4248)).toEqual({ ok: true, ignored: 'sender cannot rescan' });
    expect(await rescans(project.id)).toEqual([]);
  });

  it('does not hide a database error as a refused sender', async () => {
    await savePolicy();
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    await member(project.id, 'admin', '4249');
    vi.mocked(requireProjectCapability).mockRejectedValueOnce(new Error('database is down'));

    await expect(
      handleSecurityCheckRerequest(onEnv as unknown as ApiEnv['Bindings'], env.db, {
        installationId: 900,
        repositoryId: 9001,
        externalId: scanId,
        senderId: 4249,
      }),
    ).rejects.toThrow('database is down');
    expect(await rescans(project.id)).toEqual([]);
  });

  it('is a no-op once the checked deployment is no longer live', async () => {
    await savePolicy();
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    await member(project.id, 'admin', '4244');
    await createTestDeployment(env.db, project.id, 'live');

    expect(await rerequest(scanId, 4244)).toEqual({
      ok: true,
      ignored: 'check is not about the live deployment',
    });
    expect(await rescans(project.id)).toEqual([]);
  });

  it('follows the project rescan rules (one scan at a time, policy scope)', async () => {
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    await member(project.id, 'admin', '4245');

    // Policy Off: the project is not in scope.
    expect(await rerequest(scanId, 4245)).toEqual({ ok: true, ignored: 'security_not_in_scope' });
    await savePolicy();
    await endedScan(project.id, deployment.id, { status: 'queued', finished_at: null });
    expect(await rerequest(scanId, 4245)).toEqual({
      ok: true,
      ignored: 'security_scan_in_progress',
    });
    expect(await rescans(project.id)).toEqual([]);
  });

  it('never starts a build', async () => {
    await savePolicy();
    const { project, deployment } = await connectedProject();
    const scanId = await endedScan(project.id, deployment.id);
    await member(project.id, 'admin', '4246');
    const before = await env.db.select({ id: builds.id }).from(builds);

    await rerequest(scanId, 4246);

    expect(await env.db.select({ id: builds.id }).from(builds)).toEqual(before);
  });
});
