import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { intro } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { getApiUrl } from '../../src/cli/auth.ts';
import { runDeploy } from '../../src/cli/deploy.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const { confirm, select, text, login, oidcAvailable, exchangeOidc } = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  select: vi.fn(async () => 'create'),
  text: vi.fn(async () => 'my-app'),
  login: vi.fn(async () => 'saved-token'),
  oidcAvailable: vi.fn(() => false),
  exchangeOidc: vi.fn(),
}));
vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => ({
  ...(await original<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  confirm,
  select,
  text,
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), step: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));
vi.mock('../../src/cli/login.ts', () => ({ promptForLoginToken: login }));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: (service: string) => (service === 'dev.void.cli' ? 'saved-token' : null),
  writeKeyringPassword: vi.fn(),
  deleteKeyringPassword: vi.fn(),
}));
vi.mock('../../src/cli/github-oidc.ts', () => ({
  isGithubActionsOidcAvailable: oidcAvailable,
  exchangeGithubOidcForDeployToken: exchangeOidc,
  maskGithubActionsSecret: vi.fn(),
}));

const originalOrigin = 'https://original.example.test';
const alternateOrigin = 'https://alternate.example.test';
let root: string;
let projectFile: string;
let assets: string;
let missing: boolean;
let failDeploy: boolean;
let expirePreflight: boolean;
const requests: Array<{
  origin: string;
  path: string;
  method: string;
  authorization: string | null;
}> = [];
const originalTTY = process.stdin.isTTY;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-deploy-target-'));
  projectFile = join(root, '.void/project.json');
  assets = join(root, 'public');
  mkdirSync(join(root, '.void'));
  mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<h1>My app</h1>');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-app' }));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', join(root, 'registry'));
  vi.stubEnv('VOID_PROJECT', undefined);
  vi.stubEnv('VOID_TOKEN', 'alternate-token');
  vi.stubEnv('VOID_API_URL', alternateOrigin);
  vi.stubEnv('VOID_ACCESS_CREDENTIALS', undefined);
  vi.stubEnv('VOID_ACCESS_ORIGIN', undefined);
  for (const apiUrl of [alternateOrigin, originalOrigin]) {
    savePlatformConnection({
      apiUrl,
      displayName: apiUrl === alternateOrigin ? 'Orange Cloud' : 'Original Cloud',
      applicationDomain: 'apps.example.test',
      proxyUrl: `${apiUrl}/`,
      accountId: null,
      installationId: null,
      kind: 'connected',
    });
  }
  missing = false;
  failDeploy = false;
  expirePreflight = false;
  requests.length = 0;
  vi.mocked(intro).mockClear();
  confirm.mockClear();
  select.mockClear();
  text.mockClear();
  login.mockClear();
  oidcAvailable.mockReturnValue(false);
  exchangeOidc.mockReset();
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  vi.stubGlobal(
    'fetch',
    withPlatformDiscovery(
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const method = init?.method ?? 'GET';
        const authorization = new Headers(init?.headers).get('Authorization');
        // The best-effort security read after a deploy is not part of the deploy flow.
        if (!url.pathname.endsWith('/security')) {
          requests.push({ origin: url.origin, path: url.pathname, method, authorization });
        }
        expect([originalOrigin, alternateOrigin]).toContain(url.origin);
        const id = url.origin === originalOrigin ? 'project-original' : 'project-alternate';
        const project = { id, slug: 'my-app', role: 'owner' };
        if (url.pathname === '/projects/choices') {
          return Response.json([]);
        }
        if (url.pathname === '/projects/resolve') {
          expect(url.searchParams.get('slug')).toBe('my-app');
          return Response.json({ project: missing ? null : project });
        }
        if (method === 'POST' && url.pathname === '/projects') {
          missing = false;
          return Response.json(project);
        }
        if (method === 'GET' && url.pathname === `/projects/${id}`) {
          return Response.json(project);
        }
        if (url.pathname === `/projects/${id}/deploy/preflight`) {
          if (expirePreflight) {
            expirePreflight = false;
            return Response.json({ error: 'invalid or expired token' }, { status: 401 });
          }
          return Response.json({ needed: [], total: 1, skipped: 1 });
        }
        if (url.pathname === `/projects/${id}/deploy`) {
          return new Response(
            JSON.stringify(
              failDeploy
                ? { event: 'error', message: 'deployment refused', step: 'upload' }
                : {
                    event: 'done',
                    deployment: 'deploy-test',
                    url: 'https://app.example.test',
                    urls: ['https://app.example.test'],
                    assets: 1,
                    workers: 0,
                  },
            ) + '\n',
            {
              headers: {
                'Content-Type': 'application/x-ndjson',
                'x-void-deployment-id': 'deploy-test',
              },
            },
          );
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    ),
  );
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalTTY, configurable: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function saveOriginal(selection: Record<string, unknown> = {}) {
  const value =
    JSON.stringify(
      {
        platform: 'void',
        platformUrl: originalOrigin,
        projectId: 'project-original',
        slug: 'my-app',
        ...selection,
      },
      null,
      2,
    ) + '\n';
  writeFileSync(projectFile, value);
  return value;
}
const deploy = () =>
  runDeploy(root, { platform: 'void', projectSlug: 'my-app', dir: assets, skipBuild: true });

it('deploys to another connected platform without sending the original project ID or changing its link', async () => {
  const saved = saveOriginal();
  await deploy();
  expect(readFileSync(projectFile, 'utf8')).toBe(saved);
  expect(
    vi.mocked(intro).mock.calls.map(([message]) => stripVTControlCharacters(message!)),
  ).toEqual(['my-app → Orange Cloud']);
  expect(
    requests.every(
      ({ origin, authorization }) =>
        origin === alternateOrigin && authorization === 'Bearer alternate-token',
    ),
  ).toBe(true);
  expect(requests.some(({ path }) => path.includes('project-original'))).toBe(false);
  vi.stubEnv('VOID_API_URL', undefined);
  vi.stubEnv('VOID_TOKEN', undefined);
  expect(getApiUrl(root)).toBe(originalOrigin);
  await runDeploy(root, { dir: assets, skipBuild: true });
  expect(
    vi.mocked(intro).mock.calls.map(([message]) => stripVTControlCharacters(message!)),
  ).toEqual(['my-app → Orange Cloud', 'my-app → Original Cloud']);
  expect(requests.at(-1)).toMatchObject({
    origin: originalOrigin,
    path: '/projects/project-original/deploy',
    authorization: 'Bearer saved-token',
  });
});

it.each([false, true])(
  'preserves the link when creating the alternate project (interactive: %s)',
  async (interactive) => {
    const saved = saveOriginal();
    missing = true;
    Object.defineProperty(process.stdin, 'isTTY', { value: interactive, configurable: true });
    await deploy();
    expect(readFileSync(projectFile, 'utf8')).toBe(saved);
    expect(requests).toContainEqual(
      expect.objectContaining({ origin: alternateOrigin, method: 'POST', path: '/projects' }),
    );
    expect(requests.at(-1)?.path).toBe('/projects/project-alternate/deploy');
  },
);

it('preserves the link even when deployment fails after creating the alternate project', async () => {
  const saved = saveOriginal({ slug: 'original-app' });
  missing = true;
  failDeploy = true;
  await expect(deploy()).rejects.toThrow('deployment refused');
  expect(readFileSync(projectFile, 'utf8')).toBe(saved);
});

it.each(['cloudflare', 'none', 'other-platform', 'same-platform'])(
  'preserves an existing %s default when creating a one-time target',
  async (selection) => {
    const saved =
      selection === 'same-platform'
        ? saveOriginal({ platformUrl: alternateOrigin, slug: 'original-app' })
        : JSON.stringify(
            selection === 'other-platform'
              ? { platform: 'void', platformUrl: originalOrigin }
              : { platform: selection },
          ) + '\n';
    writeFileSync(projectFile, saved);
    missing = true;
    await deploy();
    expect(readFileSync(projectFile, 'utf8')).toBe(saved);
  },
);

it('still saves the first project link when no default is configured', async () => {
  expect(existsSync(projectFile)).toBe(false);
  missing = true;
  await deploy();
  expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toMatchObject({
    platform: 'void',
    platformUrl: alternateOrigin,
    projectId: 'project-alternate',
    slug: 'my-app',
  });
});

it('reuses a newly established first link when authentication expires during deployment', async () => {
  vi.stubEnv('VOID_TOKEN', undefined);
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  expirePreflight = true;
  await runDeploy(root, { platform: 'void', dir: assets, skipBuild: true });
  expect(login).toHaveBeenCalledOnce();
  expect(
    vi.mocked(intro).mock.calls.map(([message]) => stripVTControlCharacters(message!)),
  ).toEqual(['my-app → Orange Cloud']);
  expect(select).toHaveBeenCalledOnce();
  expect(
    requests.filter(({ path, method }) => path === '/projects' && method === 'POST'),
  ).toHaveLength(1);
  expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toMatchObject({
    platformUrl: alternateOrigin,
    projectId: 'project-alternate',
  });
  expect(requests.at(-1)?.path).toBe('/projects/project-alternate/deploy');
});

it('requires an explicit project before borrowing a different platform’s linked slug for OIDC', async () => {
  const saved = saveOriginal();
  vi.stubEnv('VOID_TOKEN', undefined);
  oidcAvailable.mockReturnValue(true);
  await expect(runDeploy(root, { platform: 'void', dir: assets })).rejects.toThrow('--project');
  expect(exchangeOidc).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
  expect(readFileSync(projectFile, 'utf8')).toBe(saved);
});
