import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { runDeploy } from '../../src/cli/deploy.ts';

// The native Cloudflare email step belongs to `void deploy --platform cloudflare` ONLY.
// This drives the MANAGED path on a project that uses email in every way the step detects
// (an `email/` handler AND `void.json` `email.from`) far enough to reach the full-deploy branch,
// and proves the email module was never invoked — no preflight, no apply, no bearer, no prompt.

const { emailModule, mockConfirm, mockPreflight, mockProjectLookup, mockClientCtor } = vi.hoisted(
  () => {
    const never = (): never => {
      throw new Error('the email module must never run on the managed platform path');
    };
    return {
      emailModule: {
        preflightEmail: vi.fn(never),
        applyEmailSetup: vi.fn(never),
        renderEmailChecklist: vi.fn(never),
        renderAddressMap: vi.fn(never),
        deriveAddresses: vi.fn(never),
        fetchWithSessionBearer: vi.fn(never),
        createNodeEmailDns: vi.fn(never),
      },
      mockConfirm: vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').confirm>(),
      mockPreflight: vi.fn<import('../../src/cli/client.ts').PlatformClient['preflight']>(),
      mockProjectLookup: vi.fn(),
      mockClientCtor: vi.fn(),
    };
  },
);

vi.mock('../../src/cli/email-cloudflare.ts', () => emailModule);

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  settings: { accessible: false },
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  isCI: () => false,
  confirm: (...args: Parameters<typeof mockConfirm>) => mockConfirm(...args),
  isCancel: () => false,
  log: {
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('../../src/cli/auth', () => ({
  getToken: () => 'token',
  getTokenSource: () => 'manual',
  getApiUrl: () => 'https://api.test',
}));

vi.mock('../../src/cli/github-oidc', () => ({
  isGithubActionsOidcAvailable: () => false,
  exchangeGithubOidcForDeployToken: vi.fn(),
  maskGithubActionsSecret: vi.fn(),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    constructor(...args: Array<unknown>) {
      mockClientCtor(...args);
    }
    listProjects() {
      throw new Error('deploy unexpectedly loaded the full project list');
    }
    async findProjectBySlug(slug: string) {
      const projects = (await mockProjectLookup()) as Array<{ slug: string }>;
      return projects.find((project: { slug: string }) => project.slug === slug) ?? null;
    }
    preflight(...args: Parameters<typeof mockPreflight>) {
      return mockPreflight(...args);
    }
  },
  isExpiredTokenError: () => false,
}));

const tmpDir = packageFixturePath(import.meta.dirname, '.tmp-deploy-email-platform-path');

function makeProject(files: Record<string, string>): string {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmpDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return tmpDir;
}

beforeEach(() => {
  for (const spy of Object.values(emailModule)) {
    spy.mockClear();
  }
  mockConfirm.mockReset();
  mockClientCtor.mockReset();
  mockProjectLookup.mockReset();
  mockPreflight.mockReset();
  mockProjectLookup.mockResolvedValue([{ id: 'proj_1', slug: 'my-app', name: 'my-app' }]);
  // The first UPLOAD call inside the full-deploy branch — a distinctive stop so the test proves
  // how far the managed path ran without a real build or network.
  mockPreflight.mockRejectedValue(new Error('stop-here: reached the managed upload'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('managed `void deploy` never runs the native Cloudflare email step', () => {
  it('reaches the full-deploy branch on an email-using project without touching the email module', async () => {
    // `dist/ssr` stands in for a built worker so `skipBuild` gets past the output check without
    // running Vite; the path then runs config, inference (which sees the `void/email` import),
    // the migration gates, and asset collection before its first upload call, `preflight`.
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'myapp' }),
      'void.json': JSON.stringify({ email: { from: 'noreply@mail.acme.com' } }),
      'routes/index.ts': `import { sendEmail } from 'void/email';\nexport const GET = () => sendEmail({});`,
      'email/support+[ticket].ts': `export default async () => {};`,
      'wrangler.jsonc': JSON.stringify({ name: 'myapp', account_id: 'acc123' }),
      'dist/ssr/index.js': 'export default {};',
      'dist/client/index.html': '<!doctype html>',
    });
    await expect(runDeploy(root, { projectSlug: 'my-app', skipBuild: true })).rejects.toThrow(
      /stop-here: reached the managed upload/,
    );
    // The managed path DID run: it built a platform client and resolved the project.
    expect(mockClientCtor).toHaveBeenCalledTimes(1);
    expect(mockProjectLookup).toHaveBeenCalledTimes(1);
    expect(mockPreflight).toHaveBeenCalledTimes(1);
    // …and never asked the email module — or the developer — anything.
    for (const [name, spy] of Object.entries(emailModule)) {
      expect(spy, name).not.toHaveBeenCalled();
    }
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
