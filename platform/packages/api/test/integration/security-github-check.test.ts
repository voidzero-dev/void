/**
 * The `Void Security Audit` GitHub check (design doc 0095 M28): a `neutral` check run
 * with counts only, which never fails and never reads as clean for a scan that did not end.
 */
import { eq } from 'drizzle-orm';
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
import { createGitHubConnection, upsertGitHubInstallation } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { builds } from '../../src/schema.ts';
import {
  reportSecurityScanToGitHub,
  VOID_SECURITY_AUDIT_CHECK_RUN_NAME,
} from '../../src/security/github-check.ts';
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
import {
  insertSecurityFinding,
  insertSecurityScan,
  securityBindings,
  storeDeploymentCode,
} from './security-fixtures.ts';

vi.mock('../../src/github/installation-token.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/github/installation-token.ts')>()),
  getInstallationToken: vi.fn(async () => 'app-token'),
}));

const HEAD = 'c'.repeat(40);
const REPO = 'acme/web';
const API = 'https://api.github.com';

let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = {
    ...securityBindings(env, { capabilities: { managedBuilds: true } }),
    GITHUB_APP_ID: '1234',
    GITHUB_APP_PRIVATE_KEY: 'unused: the token mint is mocked',
    AUTH_REDIRECT_URI: 'https://api.example.test/auth/callback',
  } as unknown as TestEnv;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Call = { method: string; url: string; body: unknown };

/** GitHub stand-in: check runs, and no pull requests for the commit. */
function stubGithub(options: { createStatus?: number } = {}) {
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
        return Response.json([]);
      }
      return new Response('not stubbed', { status: 404 });
    }),
  );
  return calls;
}

/** A project connected to `acme/web`, live on a container build of `HEAD`. */
async function connectedProject() {
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
    buildExecutor: 'container',
  });
  const deployment = await createTestDeployment(env.db, project.id, 'live', undefined, undefined, {
    commit: HEAD,
  });
  const build = await createTestBuild(env.db, {
    projectId: project.id,
    userId: owner.id,
    executor: 'container',
    commitSha: HEAD,
    branch: 'main',
    status: 'complete',
  });
  await env.db.update(builds).set({ deployment_id: deployment.id }).where(eq(builds.id, build.id));
  await storeDeploymentCode(env, project.id, deployment.id);
  return { project, deployment };
}

function report(scanId: string) {
  return reportSecurityScanToGitHub(onEnv as unknown as ApiEnv['Bindings'], env.db, scanId);
}

describe('reportSecurityScanToGitHub', () => {
  it('completes the check on the build commit as neutral, with counts only (I1)', async () => {
    const { project, deployment } = await connectedProject();
    await insertSecurityFinding(env, project.id, {
      number: 1,
      severity: 'critical',
      title: 'SQL built from the request query',
    });
    const scanId = await insertSecurityScan(env, project.id, deployment.id, { tier: 'built_diff' });
    const calls = stubGithub();

    expect(await report(scanId)).toEqual({ reported: true, checkRunId: '777', comments: 0 });
    const create = calls.find((call) => call.url === `${API}/repos/${REPO}/check-runs`)!;
    expect(create.body).toMatchObject({ name: VOID_SECURITY_AUDIT_CHECK_RUN_NAME, head_sha: HEAD });
    expect(calls.find((call) => call.method === 'PATCH')!.body).toMatchObject({
      status: 'completed',
      conclusion: 'neutral',
    });
    // Public repos show check runs to anyone: no finding title.
    expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('SQL built');
  });

  it('says a timed-out scan did not finish, never clean (I10)', async () => {
    const { project, deployment } = await connectedProject();
    const scanId = await insertSecurityScan(env, project.id, deployment.id, {
      tier: 'built_diff',
      status: 'timed_out',
      failure_cause: 'project',
    });
    const calls = stubGithub();
    await report(scanId);
    expect(calls.find((call) => call.method === 'PATCH')!.body).toMatchObject({
      conclusion: 'neutral',
      output: { title: 'Security scan did not finish (timed out)' },
    });
  });

  it('never throws when GitHub refuses the check (I1)', async () => {
    const { project, deployment } = await connectedProject();
    const scanId = await insertSecurityScan(env, project.id, deployment.id, { tier: 'built_diff' });
    stubGithub({ createStatus: 422 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await report(scanId)).toEqual({ reported: true, checkRunId: null, comments: 0 });
  });
});
