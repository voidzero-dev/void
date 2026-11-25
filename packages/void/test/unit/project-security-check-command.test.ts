import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Buffer } from '../../src/cli/node-buffer.ts';
import type { SecurityCheckDeps } from '../../src/cli/project-security-check.ts';
import { runProjectSecurityCommand } from '../../src/cli/project-security.ts';
import { captureOutput, linkedProject } from '../helpers/cli-command.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';
import { scanSummary } from '../helpers/security-status.ts';

const linked = () => linkedProject({ slug: 'acme-web' });

function write(root: string, files: Record<string, string | Uint8Array>) {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), data);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CHECKS = '/projects/project_1/security/checks';
const UPLOAD =
  'https://acct.r2.cloudflarestorage.com/bucket/security-scans/p/scans/scan_9/local-tree.tar.gz';

const preview = {
  dryRun: true,
  model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  thirdParty: false,
  notice: null,
  worstCaseUsd: 0.5,
  budget: null,
  limits: { maxFiles: 10_000, maxBytes: 32 * 1024 * 1024, maxArchiveBytes: 32 * 1024 * 1024 },
};

const check = {
  ...scanSummary({
    id: 'scan_9',
    trigger: 'local',
    deploymentId: null,
    baseDeploymentId: null,
    model: null,
    meteredUsd: 0,
    createdAt: '2026-11-20T10:00:00.000Z',
  }),
  coverageNotes: [],
};

const ended = {
  check: {
    ...check,
    status: 'succeeded',
    coverageLabel: 'full scan (local check)',
    filesScanned: 2,
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  },
  ended: true,
  result: {
    version: 1,
    total: 2,
    capped: false,
    findings: [
      {
        verdict: 'confirmed',
        severity: 'high',
        confidence: 'high',
        title: 'SQL injection in /users\u001b[31m',
        category: 'sql-injection',
        cwe: 'CWE-89',
        file: 'src/routes/users.ts',
        lineStart: 3,
        lineEnd: 3,
        source: 'scanner',
        verdictSource: 'static',
        detail: {},
      },
      {
        verdict: 'needs_validation',
        severity: null,
        confidence: null,
        title: 'Possible open redirect',
        category: 'open-redirect',
        cwe: null,
        file: 'src/app.tsx',
        lineStart: null,
        lineEnd: null,
        source: 'scanner',
        verdictSource: 'static',
        detail: {},
      },
    ],
  },
};

type Call = { method: string; url: string; body: unknown };

/** The platform and storage: handlers by `METHOD path` (the upload by its full URL). */
function route(handlers: Record<string, () => Response>) {
  const calls: Array<Call> = [];
  const impl = withPlatformDiscovery(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    const upload = url.href === UPLOAD;
    calls.push({
      method,
      url: upload ? 'UPLOAD' : url.pathname,
      body: upload ? init?.body : init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const handler = handlers[upload ? `${method} UPLOAD` : `${method} ${url.pathname}`];
    return handler ? handler() : new Response('404 Not Found', { status: 404 });
  });
  vi.stubGlobal('fetch', impl);
  return { calls, fetch: impl };
}

function platform(view: () => unknown = () => ended) {
  return {
    [`POST ${CHECKS}`]: (() => {
      let posts = 0;
      return () =>
        ++posts === 1
          ? Response.json(preview)
          : Response.json(
              {
                ok: true,
                checkId: 'scan_9',
                upload: { url: UPLOAD, headers: { 'Content-Md5': 'x', 'Content-Length': '1' } },
                expiresAt: '2026-11-20T10:30:00.000Z',
                model: preview.model,
                thirdParty: false,
              },
              { status: 201 },
            );
    })(),
    'PUT UPLOAD': () => new Response(null, { status: 200 }),
    [`POST ${CHECKS}/scan_9/start`]: () =>
      Response.json({ checkId: 'scan_9', status: 'queued' }, { status: 202 }),
    [`GET ${CHECKS}/scan_9`]: () => Response.json(view()),
  };
}

const APP = {
  'src/routes/users.ts': 'export const GET = () => db.prepare(`... ${id}`);\n',
  'src/app.tsx': 'export const App = () => null;\n',
};

function deps(files: Array<string>, extra: Partial<SecurityCheckDeps> = {}) {
  return {
    interactive: false,
    check: { listFiles: () => files, sleep: async () => {}, ...extra },
  };
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    subcommand: 'security' as const,
    projectSlug: '',
    json: false,
    action: 'check' as const,
    checkId: '',
    yes: true,
    wait: true,
    ...overrides,
  };
}

describe('void project security check', () => {
  it('keeps secret-like files and links out, previews, uploads, starts, waits and prints', async () => {
    const root = linked();
    write(root, { ...APP, '.env': 'SECRET=1', 'pnpm-lock.yaml': 'lockfileVersion: 9' });
    symlinkSync(join(root, 'src/app.tsx'), join(root, 'link.ts'));
    let gets = 0;
    const { calls, fetch } = route(
      platform(() => (++gets === 1 ? { check, ended: false, result: null } : ended)),
    );
    const out = captureOutput();
    const files = [...Object.keys(APP), '.env', 'pnpm-lock.yaml', 'link.ts'];
    await runProjectSecurityCommand(root, args(), deps(files, { fetch }));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${CHECKS}`,
      `POST ${CHECKS}`,
      'PUT UPLOAD',
      `POST ${CHECKS}/scan_9/start`,
      `GET ${CHECKS}/scan_9`,
      `GET ${CHECKS}/scan_9`,
    ]);
    expect(calls[0]?.body).toMatchObject({ dryRun: true, files: 2 });
    const tar = gunzipSync(calls[2]?.body as Buffer).toString('latin1');
    expect(tar).toContain('tree/src/routes/users.ts');
    expect(tar).not.toContain('SECRET=1');
    expect(tar).not.toContain('lockfileVersion');
    expect(tar).not.toContain('link.ts');
    expect(out.output()).toContain('Not sent: 1 secret-like file (.env).');
    expect(out.output()).toContain('1 finding (1 high) · 1 lead');
    expect(out.output()).not.toContain('\u001b[31m');
  });

  it('needs --yes without a terminal, before anything is sent', async () => {
    const root = linked();
    write(root, APP);
    const { calls } = route(platform());
    await expect(
      runProjectSecurityCommand(root, args({ yes: false }), deps(Object.keys(APP))),
    ).rejects.toThrow('Add --yes to send the code without a prompt.');
    expect(calls).toHaveLength(0);
  });
});
