import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import { parseProjectArgs } from '../../src/cli/project-args.ts';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';
import { collectSecurityLocalTree } from '../../src/cli/project-security-check.ts';
import type { SecurityCheckDeps } from '../../src/cli/project-security-check.ts';
import { runProjectSecurityCommand } from '../../src/cli/project-security.ts';
import { captureOutput, linkedProject } from '../helpers/cli-command.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';
import { scanSummary } from '../helpers/security-status.ts';

const roots: Array<string> = [];

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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };

/** The platform and storage: handlers by `METHOD path` (the upload by its full URL). */
function route(handlers: Record<string, () => Response>) {
  const calls: Array<Call> = [];
  const impl = withPlatformDiscovery(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    const upload = url.href === UPLOAD;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      method,
      url: upload ? 'UPLOAD' : url.pathname,
      body: upload ? init?.body : init?.body ? JSON.parse(String(init.body)) : undefined,
      headers,
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

describe('security check arguments', () => {
  it('parses a new check, an earlier one and --no-wait', () => {
    expect(parseProjectArgs(['security', 'check'])).toMatchObject({
      action: 'check',
      checkId: '',
      yes: false,
      wait: true,
    });
    expect(parseProjectArgs(['security', 'check', '--yes', '--no-wait'])).toMatchObject({
      yes: true,
      wait: false,
    });
    expect(parseProjectArgs(['security', 'check', 'scan_9'])).toMatchObject({ checkId: 'scan_9' });
    expect(() => parseProjectArgs(['security', 'check', 'scan_9', '--yes'])).toThrow(
      '--yes is used only when a new check starts',
    );
    expect(() => parseProjectArgs(['security', 'check', 'a', 'b'])).toThrow(
      "Unexpected argument 'b'",
    );
    expect(() => parseProjectArgs(['security', 'check', '--client-assets'])).toThrow(
      '--client-assets is not used with security check',
    );
  });
});

describe('collecting the local tree', () => {
  it('keeps code, drops secret-like files, lockfiles, binaries, links and deleted files', () => {
    const root = linked();
    write(root, {
      ...APP,
      '.env.local': 'TOKEN=x',
      'certs/server.pem': 'KEY',
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'logo.png': 'png',
      'blob.dat2': new Uint8Array([1, 0, 2]),
    });
    symlinkSync(join(root, 'src/app.tsx'), join(root, 'link.ts'));
    const tree = collectSecurityLocalTree(root, () => [
      'src/routes/users.ts',
      'src/app.tsx',
      '.env.local',
      'certs/server.pem',
      'pnpm-lock.yaml',
      'logo.png',
      'blob.dat2',
      'link.ts',
      'deleted.ts',
    ]);
    expect(tree.files.map((file) => file.path)).toEqual(['src/routes/users.ts', 'src/app.tsx']);
    expect(tree.secret).toEqual(['.env.local', 'certs/server.pem']);
    expect(tree.skipped).toBe(5);
    expect(tree.bytes).toBe(APP['src/routes/users.ts'].length + APP['src/app.tsx'].length);
  });

  it('sends only git-tracked files, with edits on disk, relative to this folder', () => {
    const repo = mkdtempSync(join(tmpdir(), 'void-security-check-git-'));
    roots.push(repo);
    const git = (...cmd: Array<string>) =>
      execFileSync('git', cmd, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    write(repo, {
      'apps/web/src/index.ts': 'one',
      'apps/web/README.md': 'docs',
      'other/x.ts': 'x',
    });
    git('add', '.');
    write(repo, { 'apps/web/src/index.ts': 'edited', 'apps/web/src/new.ts': 'untracked' });
    const tree = collectSecurityLocalTree(join(repo, 'apps/web'));
    expect(
      tree.files
        .map((file) => [file.path, Buffer.from(file.data).toString()])
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual([
      ['README.md', 'docs'],
      ['src/index.ts', 'edited'],
    ]);
  });

  it('refuses a folder that is not a git repository or is over the limits', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-security-check-nogit-'));
    roots.push(root);
    expect(() => collectSecurityLocalTree(root)).toThrow('not in a git repository');
    write(root, { 'big.ts': 'x'.repeat(8192) });
    truncateSync(join(root, 'big.ts'), 33 * 1024 * 1024);
    expect(() => collectSecurityLocalTree(root, () => ['big.ts'])).toThrow(
      'at most 32 MB of code, and this folder has 33.0 MB',
    );
  });

  it('stops at the limits from the sizes on disk, before reading a file over them', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-security-check-size-'));
    roots.push(root);
    // 3 GB on disk (sparse): reading it whole would not even fit in a buffer.
    write(root, { 'a.ts': 'one', 'dump.sql': 'x'.repeat(8192), 'blob.dat2': new Uint8Array(8192) });
    truncateSync(join(root, 'dump.sql'), 3 * 1024 ** 3);
    // A big binary is never sent, so it does not count.
    truncateSync(join(root, 'blob.dat2'), 3 * 1024 ** 3);
    expect(collectSecurityLocalTree(root, () => ['a.ts', 'blob.dat2']).files).toHaveLength(1);
    expect(() => collectSecurityLocalTree(root, () => ['a.ts', 'dump.sql'])).toThrow(
      'at most 32 MB of code, and this folder has 3072.0 MB or more',
    );
  });
});

describe('project security check (M32)', () => {
  it('previews, uploads the archive, starts it, waits and prints the result', async () => {
    const root = linked();
    write(root, { ...APP, '.env': 'SECRET=1' });
    let gets = 0;
    const { calls, fetch } = route(
      platform(() => (++gets === 1 ? { check, ended: false, result: null } : ended)),
    );
    const out = captureOutput();
    await runProjectSecurityCommand(
      root,
      args(),
      deps(['src/routes/users.ts', 'src/app.tsx', '.env'], { fetch }),
    );
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${CHECKS}`,
      `POST ${CHECKS}`,
      'PUT UPLOAD',
      `POST ${CHECKS}/scan_9/start`,
      `GET ${CHECKS}/scan_9`,
      `GET ${CHECKS}/scan_9`,
    ]);
    const [dry, create] = calls as [Call, Call];
    expect(dry.body).toMatchObject({ dryRun: true, files: 2 });
    expect(create.body).toEqual({ ...(dry.body as object), dryRun: undefined });
    // The upload is the gzip tar of the two files, under `tree/`, with the signed headers.
    const put = calls[2];
    expect(put.headers['content-md5']).toBe('x');
    const tar = gunzipSync(put.body as Buffer).toString('latin1');
    expect(tar).toContain('tree/src/routes/users.ts');
    expect(tar).toContain('tree/src/app.tsx');
    expect(tar).not.toContain('SECRET=1');
    const text = out.output();
    expect(text).toContain('Security check of acme-web: 2 git-tracked files');
    expect(text).toContain('Not sent: 1 secret-like file (.env).');
    expect(text).toContain('It can cost up to $0.50; monthly caps apply.');
    expect(text).toContain('✓ Check scan_9 queued.');
    expect(text).toContain('Waiting in the scan queue…');
    expect(text).toContain('acme-web · local check scan_9');
    expect(text).toContain('1 finding (1 high) · 1 lead');
    expect(text).toContain('HIGH      SQL injection in /users');
    expect(text).not.toContain('\u001b[31m');
    expect(text).toContain('src/routes/users.ts:3');
    expect(text).toContain('LEAD      Possible open redirect');
    expect(text).toContain('Not saved as project findings.');
  });

  it('asks first on a terminal, shows the provider notice, and sends nothing on no', async () => {
    const root = linked();
    write(root, APP);
    const third = {
      ...preview,
      model: 'anthropic/claude-opus-5.5',
      thirdParty: true,
      notice: ['This model is run by Anthropic, not by Cloudflare.'],
    };
    const { calls } = route({ [`POST ${CHECKS}`]: () => Response.json(third) });
    const out = captureOutput();
    const asked: Array<string> = [];
    await runProjectSecurityCommand(root, args({ yes: false }), {
      interactive: true,
      confirm: async (message) => {
        asked.push(message);
        return false;
      },
      check: { listFiles: () => Object.keys(APP) },
    });
    expect(asked).toEqual([
      'Send these files for a security check with anthropic/claude-opus-5.5?',
    ]);
    expect(out.output()).toContain('This model is run by Anthropic, not by Cloudflare.');
    expect(out.output()).toContain('Nothing was sent.');
    expect(calls).toHaveLength(1);
  });

  it('needs --yes without a terminal or with --json, before anything is sent', async () => {
    const root = linked();
    write(root, APP);
    const { calls } = route(platform());
    await expect(
      runProjectSecurityCommand(root, args({ yes: false }), deps(Object.keys(APP))),
    ).rejects.toThrow('Add --yes to send the code without a prompt.');
    await expect(
      runProjectSecurityCommand(root, args({ yes: false, json: true }), {
        ...deps(Object.keys(APP)),
        interactive: true,
      }),
    ).rejects.toThrow('Add --yes');
    expect(calls).toHaveLength(0);
  });

  it('prints JSON and fails when the check ends with no result', async () => {
    const root = linked();
    write(root, APP);
    const refused = {
      check: {
        ...check,
        status: 'refused',
        failureCause: 'project',
        refusalCategory: 'cyber',
        model: 'anthropic/claude-opus-5.5',
      },
      ended: true,
      result: null,
    };
    const { fetch } = route(platform(() => refused));
    const out = captureOutput();
    await expect(
      runProjectSecurityCommand(root, args({ json: true }), deps(Object.keys(APP), { fetch })),
    ).rejects.toThrow(
      'The check was refused by anthropic/claude-opus-5.5 (category: cyber). Pick another model',
    );
    expect(JSON.parse(out.output())).toMatchObject({ check: { status: 'refused' }, ended: true });
  });

  it('keeps the "See it later" hint when the wait fails, and none for a missing check', async () => {
    const root = linked();
    write(root, APP);
    for (const [status, body] of [
      [401, { error: 'Your session is no longer active' }],
      [503, { error: 'Platform disabled' }],
    ] as const) {
      const { fetch } = route({
        ...platform(),
        [`GET ${CHECKS}/scan_9`]: () => Response.json(body, { status }),
      });
      const out = captureOutput();
      await expect(
        runProjectSecurityCommand(root, args(), deps(Object.keys(APP), { fetch })),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(out.output(), String(status)).toContain(
        'The check keeps running. See it later: void project security check scan_9',
      );
    }

    // With --json the hint goes to stderr, so stdout stays JSON.
    const { fetch } = route({
      ...platform(),
      [`GET ${CHECKS}/scan_9`]: () => Response.json({ error: 'x' }, { status: 401 }),
    });
    const out = captureOutput();
    const errors: Array<string> = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a.join(' ')));
    await expect(
      runProjectSecurityCommand(root, args({ json: true }), deps(Object.keys(APP), { fetch })),
    ).rejects.toThrow('HTTP 401');
    expect(out.output()).toBe('');
    expect(errors.join('\n')).toContain('See it later: void project security check scan_9');

    const gone = route({
      ...platform(),
      [`GET ${CHECKS}/scan_9`]: () => Response.json({ error: 'not found' }, { status: 404 }),
    });
    const missing = captureOutput();
    await expect(
      runProjectSecurityCommand(root, args(), deps(Object.keys(APP), { fetch: gone.fetch })),
    ).rejects.toThrow();
    expect(missing.output()).not.toContain('See it later');
  });

  it('shows an earlier check without sending anything, and returns at once with --no-wait', async () => {
    const root = linked();
    const { calls } = route(platform());
    const out = captureOutput();
    await run(root, ['security', 'check', 'scan_9']);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${CHECKS}/scan_9`,
      `GET ${CHECKS}/scan_9`,
    ]);
    expect(out.output()).toContain('HIGH      SQL injection in /users');

    const waiting = route({
      [`GET ${CHECKS}/scan_9`]: () => Response.json({ check, ended: false, result: null }),
    });
    const later = captureOutput();
    await run(root, ['security', 'check', 'scan_9', '--no-wait']);
    expect(waiting.calls).toHaveLength(2);
    expect(later.output()).toContain('See the result: void project security check scan_9');
  });

  it('goes on to start when the upload landed but its reply was lost (412 on the retry)', async () => {
    const root = linked();
    write(root, APP);
    let puts = 0;
    const { calls, fetch } = route({
      ...platform(),
      'PUT UPLOAD': () => {
        puts++;
        if (puts === 1) {
          throw new TypeError('fetch failed');
        }
        return new Response('PreconditionFailed', { status: 412 });
      },
    });
    captureOutput();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const done = runProjectSecurityCommand(root, args(), deps(Object.keys(APP), { fetch }));
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(`POST ${CHECKS}/scan_9/start`);
  });

  it('starts an earlier check whose start was lost, once', async () => {
    const root = linked();
    let gets = 0;
    const { calls } = route({
      ...platform(),
      [`GET ${CHECKS}/scan_9`]: () =>
        Response.json(
          ++gets === 1
            ? { check: { ...check, status: 'pending_input' }, ended: false, result: null }
            : ended,
        ),
    });
    captureOutput();
    await run(root, ['security', 'check', 'scan_9']);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${CHECKS}/scan_9`,
      `POST ${CHECKS}/scan_9/start`,
      `GET ${CHECKS}/scan_9`,
    ]);
  });

  it('fails when a check that just ended has no result; an earlier one names the 30 days', async () => {
    const root = linked();
    write(root, APP);
    const missing = { ...ended, result: null };
    const { fetch } = route(platform(() => missing));
    const out = captureOutput();
    await expect(
      runProjectSecurityCommand(root, args(), deps(Object.keys(APP), { fetch })),
    ).rejects.toThrow('The check ended, but its result could not be read. Run it again.');
    expect(out.output()).toContain('The result is missing.');
    expect(out.output()).not.toContain('30 days).');

    const later = captureOutput();
    await expect(run(root, ['security', 'check', 'scan_9'])).rejects.toThrow(
      'The result of this check is no longer stored',
    );
    expect(later.output()).toContain('results are kept for 30 days');
  });

  it('names an older platform that has no local checks', async () => {
    const root = linked();
    write(root, APP);
    route({});
    await expect(runProjectSecurityCommand(root, args(), deps(Object.keys(APP)))).rejects.toThrow(
      'cannot run local security checks yet',
    );
  });
});

const run = (root: string, argv: Array<string>) => runProjectCommand(root, parseProjectArgs(argv));
