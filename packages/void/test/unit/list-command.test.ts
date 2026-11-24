import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { captureOutput } from '../helpers/cli-command.ts';

const tempHomes: Array<string> = [];
const mockGetToken = vi.fn<() => string | null>();

vi.mock('../../src/cli/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/auth.ts')>()),
  getToken: () => mockGetToken(),
  getApiUrl: () => 'https://api.example.test',
}));

function setIsolatedHome(): void {
  const dir = mkdtempSync(join(tmpdir(), 'void-home-'));
  tempHomes.push(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

async function importRunListCommand() {
  vi.resetModules();
  const mod = await import('../../src/cli/list.ts');
  return mod.runListCommand;
}

describe('runListCommand', () => {
  beforeEach(() => {
    mockGetToken.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    delete process.env.VOID_TOKEN;
    delete process.env.VOID_API_URL;

    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    while (tempHomes.length > 0) {
      const dir = tempHomes.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits with error when not logged in', async () => {
    setIsolatedHome();

    const capture = captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runListCommand = await importRunListCommand();
    const root = mkdtempSync(join(tmpdir(), 'void-list-'));
    tempHomes.push(root);
    await expect(runListCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('Not logged in');
  });

  it('exits with error when no linked project and no slug', async () => {
    setIsolatedHome();
    mockGetToken.mockReturnValue('test-token');

    const capture = captureOutput();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runListCommand = await importRunListCommand();
    const root = mkdtempSync(join(tmpdir(), 'void-list-'));
    tempHomes.push(root);
    await expect(runListCommand(root)).rejects.toThrow('process.exit:1');
    const out = capture.output();
    capture.restore();

    expect(out).toContain('No linked project found');
  });

  it('summarizes per-path revalidation rules in the isr column', async () => {
    setIsolatedHome();
    mockGetToken.mockReturnValue('test-token');
    const root = mkdtempSync(join(tmpdir(), 'void-list-'));
    tempHomes.push(root);
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(
      join(root, '.void', 'project.json'),
      JSON.stringify({
        projectId: 'proj-1',
        slug: 'demo',
      }),
    );
    const deployment = (id: string, manifest: Record<string, unknown>) => ({
      id,
      status: 'live',
      source: 'cli',
      commit: null,
      manifest: JSON.stringify(manifest),
      error_message: null,
      retained: true,
      applied_migrations: null,
      created_at: '2026-01-01T00:00:00Z',
      deployed_at: '2026-01-01T00:00:00Z',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          deployments: [
            deployment('dep-one-rule', { type: 'ssr', pathRevalidate: { '/a': 60 } }),
            deployment('dep-two-rules', { type: 'ssr', pathRevalidate: { '/a': 60, '/b': 30 } }),
            deployment('dep-global', {
              type: 'ssr',
              revalidate: 120,
              pathRevalidate: { '/a': 60 },
            }),
            deployment('dep-none', { type: 'ssr' }),
          ],
          activeDeploymentId: 'dep-one-rule',
        }),
      ),
    );

    const capture = captureOutput();
    const runListCommand = await importRunListCommand();
    await runListCommand(root);
    const out = capture.output();
    capture.restore();

    const rowFor = (id: string) => out.split('\n').find((line) => line.includes(id)) ?? '';
    expect(rowFor('dep-one-rule')).toMatch(/\b1 rule\b/);
    expect(rowFor('dep-two-rules')).toMatch(/\b2 rules\b/);
    expect(rowFor('dep-global')).toMatch(/\b120s\b/);
    expect(rowFor('dep-none')).not.toMatch(/rule|\d+s\b/);
  });

  it('prints platform warnings before the deployment table', async () => {
    setIsolatedHome();
    mockGetToken.mockReturnValue('test-token');
    const root = mkdtempSync(join(tmpdir(), 'void-list-'));
    tempHomes.push(root);
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(
      join(root, '.void', 'project.json'),
      JSON.stringify({ projectId: 'proj-1', slug: 'demo' }),
    );
    const body = (warnings?: Array<string>) => ({
      deployments: [
        {
          id: 'dep-live',
          status: 'live',
          source: 'cli',
          commit: null,
          manifest: JSON.stringify({ type: 'ssr' }),
          error_message: null,
          retained: true,
          applied_migrations: null,
          created_at: '2026-01-01T00:00:00Z',
          deployed_at: '2026-01-01T00:00:00Z',
        },
      ],
      activeDeploymentId: 'dep-live',
      ...(warnings ? { warnings } : {}),
    });

    const run = async (warnings?: Array<string>) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(body(warnings))),
      );
      const capture = captureOutput();
      const runListCommand = await importRunListCommand();
      const { log } = await import('@voidzero-dev/vite-plus-prompts');
      const warnedAt: Array<number> = [];
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {
        warnedAt.push(capture.output().length);
      });
      // The prompts module survives vi.resetModules(), so a second spyOn
      // returns the first spy with its earlier calls.
      warn.mockClear();
      await runListCommand(root);
      const out = capture.output();
      capture.restore();
      return { warn, warnedAt, tableAt: out.indexOf('dep-live') };
    };

    const warned = await run(['stuck \u001b[31mred']);
    expect(warned.warn).toHaveBeenCalledTimes(1);
    expect(warned.warn).toHaveBeenCalledWith('stuck  [31mred');
    expect(warned.tableAt).toBeGreaterThan(warned.warnedAt[0]);

    const quiet = await run();
    expect(quiet.warn).not.toHaveBeenCalled();
  });

  describe('security line', () => {
    const listBody = {
      deployments: [
        {
          id: 'dep-live',
          status: 'live',
          source: 'cli',
          commit: null,
          manifest: JSON.stringify({ type: 'ssr' }),
          error_message: null,
          retained: true,
          applied_migrations: null,
          created_at: '2026-01-01T00:00:00Z',
          deployed_at: '2026-01-01T00:00:00Z',
        },
      ],
      activeDeploymentId: 'dep-live',
    };

    const run = async (security: () => Response | Promise<Response>) => {
      setIsolatedHome();
      mockGetToken.mockReturnValue('test-token');
      const root = mkdtempSync(join(tmpdir(), 'void-list-'));
      tempHomes.push(root);
      mkdirSync(join(root, '.void'), { recursive: true });
      writeFileSync(
        join(root, '.void', 'project.json'),
        JSON.stringify({ projectId: 'proj-1', slug: 'demo' }),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) =>
          String(input).includes('/security') ? security() : Response.json(listBody),
        ),
      );
      const capture = captureOutput();
      const runListCommand = await importRunListCommand();
      await runListCommand(root);
      const out = capture.output();
      capture.restore();
      return out;
    };

    const reply = (urgent: number, mode = 'all') =>
      Response.json({
        policy: { mode, applies: true, reason: 'x', publicGate: false },
        urgent: {
          count: urgent,
          counts: { critical: urgent, high: 0 },
          findings: [],
          more: 0,
          detail: 'full',
        },
        model: {
          id: null,
          requested: 'x',
          source: null,
          thirdParty: false,
          noticeAccepted: false,
          pendingDefault: null,
        },
        counts: { open: {}, leads: 3, resolved: 0, urgent },
      });

    it('shows the urgent count and leads', async () => {
      const out = await run(() => reply(2));
      expect(out).toContain(
        'Security  2 urgent open · 3 leads → void project security list --urgent',
      );
      expect(out.indexOf('Security  2')).toBeLessThan(out.indexOf('dep-live'));
    });

    it('says none are open', async () => {
      expect(await run(() => reply(0))).toContain('Security  no urgent findings open');
    });

    it.each([
      ['audits off', () => reply(2, 'disabled')],
      ['404 from an old platform', () => new Response('Not Found', { status: 404 })],
      ['500', () => new Response('boom', { status: 500 })],
    ])('prints no security line on %s', async (_name, security) => {
      const out = await run(security);
      expect(out).not.toContain('Security  ');
      expect(out).toContain('dep-live');
    });
  });
});
