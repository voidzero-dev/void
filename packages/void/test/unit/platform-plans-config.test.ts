import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultPlanCatalog, PLAN_LIMITS } from '@void/platform/plans';
import { confirm, outro, select, text } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { pc } from '../../src/cli/output.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { parsePlatformPlansArgs } from '../../src/cli/platform-plans-args.ts';
import { runPlatformPlansConfig } from '../../src/cli/platform-plans-config.ts';

vi.mock('../../src/cli/operator-auth.ts', () => ({
  resolveOperatorOrigin: () => 'https://api.example.com',
  readOperatorToken: () => 'operator-fixture',
}));
vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  outro: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
let directory: string;
let calls: Array<{ url: string; body?: Record<string, unknown> }>;
let revision = 7;
let pending = false;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'void-plans-config-'));
  calls = [];
  revision = 7;
  pending = false;
  vi.mocked(confirm).mockReset();
  vi.mocked(outro).mockReset();
  vi.mocked(select).mockReset();
  vi.mocked(text).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      const catalog = {
        revision,
        defaultPlanId: 'custom',
        plans: [
          {
            id: 'custom',
            name: 'Custom',
            archived: false,
            limits: PLAN_LIMITS.custom,
            buildInstanceType: 'standard-4',
          },
          {
            id: 'free',
            name: 'Free',
            archived: false,
            limits: PLAN_LIMITS.free,
            buildInstanceType: 'standard-3',
          },
        ],
        reconciliation: null,
      };
      if (init?.method === 'GET') {
        return Response.json({ catalog, accounts: [{ planId: 'free', count: 2 }] });
      }
      if (body?.dryRun) {
        return Response.json({
          dryRun: true,
          expectedRevision: revision,
          catalog,
          affectedAccounts: 2,
          overLimitAccounts: [],
        });
      }
      if (body?.expectedRevision !== revision) {
        return Response.json(
          { error: 'revision_conflict', message: 'Plan configuration changed; preview again.' },
          { status: 409 },
        );
      }
      return Response.json({ catalog, reconciliation: { complete: !pending, processed: 2 } });
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe('platform config plans', () => {
  it('shows the replacement and changed limits in a removal preview', async () => {
    const catalog = createDefaultPlanCatalog('custom');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'GET') {
          return Response.json({ catalog, accounts: [{ planId: 'custom', count: 2 }] });
        }
        return Response.json({
          dryRun: true,
          action: 'plans.remove',
          target: 'custom',
          expectedRevision: 0,
          removedPlanId: 'custom',
          replacementPlanId: 'free',
          affectedAccounts: 2,
          catalog: {
            ...catalog,
            revision: 1,
            defaultPlanId: 'free',
            plans: catalog.plans.filter((plan) => plan.id !== 'custom'),
          },
        });
      }),
    );
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'remove', 'custom', '--replacement', 'free', '--plan']),
    );
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => call[0])
      .join('\n');
    expect(output).toContain('Move accounts to free (free)');
    expect(output).toContain('Requests per billing month: unlimited → 3,000,000');
    expect(output).toContain('Build size: standard-4 → standard-3');
    expect(output).toContain('Short project slugs: allowed → not allowed');
  });

  it('routes plan configuration independently from authentication and operator account assignment', () => {
    expect(parsePlatformArgs(['config', 'plans'])).toMatchObject({
      configGroup: 'plans',
      action: '',
    });
    expect(parsePlatformArgs(['config'])).toEqual({
      subcommand: 'config',
      configGroup: '',
      plan: false,
      yes: false,
    });
    expect(parsePlatformArgs(['config', 'auth'])).not.toHaveProperty('configGroup');
    expect(parsePlatformArgs(['user', 'plan', 'user-1', 'company'])).toMatchObject({
      group: 'user',
      action: 'plan',
      body: { plan: 'company' },
    });
  });
  it.each([
    ['plans', 'remove'],
    ['plans', 'show', 'free', '--file', 'x'],
    ['plans', 'sync', 'free'],
    ['plans', 'set', '../free', '--name', 'New'],
    ['plans', 'add', 'team', '--copy', 'free', '--plan', '--yes'],
    ['plans', 'add', 'team', '--copy', 'free', '--copy', 'pro'],
    ['plans', 'set', 'free', '--replacement', 'pro'],
  ])('rejects invalid arguments %j', (...args) => {
    expect(() => parsePlatformPlansArgs(args)).toThrow();
  });
  it('prints a read-only preview with partial numeric limits and preserved plan identity', async () => {
    const file = join(directory, 'limits.json');
    await writeFile(
      file,
      JSON.stringify({ name: 'Team', limits: { requestsPerMonth: 10_000_000 } }),
    );
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'set', 'free', '--file', file, '--plan', '--json']),
    );
    expect(calls.filter((call) => call.body)).toEqual([
      {
        url: 'https://api.example.com/operator/v1/config/plans/free/set',
        body: { name: 'Team', limits: { requestsPerMonth: 10_000_000 }, dryRun: true },
      },
    ]);
    expect(console.log).toHaveBeenCalledTimes(1);
  });
  it('copies a plan, previews, then applies using the exact preview revision', async () => {
    await runPlatformPlansConfig(
      parsePlatformPlansArgs([
        'plans',
        'add',
        'team',
        '--copy',
        'free',
        '--name',
        'Team',
        '--yes',
        '--json',
      ]),
    );
    expect(calls.filter((call) => call.body)).toEqual([
      {
        url: 'https://api.example.com/operator/v1/config/plans/add',
        body: { id: 'team', copyFrom: 'free', name: 'Team', dryRun: true },
      },
      {
        url: 'https://api.example.com/operator/v1/config/plans/add',
        body: { id: 'team', copyFrom: 'free', name: 'Team', expectedRevision: 7 },
      },
    ]);
  });
  it.each(['d1StorageBytes', 'unknownLimit'])(
    'rejects unsupported limit %s before any mutation',
    async (key) => {
      const file = join(directory, 'limits.json');
      await writeFile(file, JSON.stringify({ limits: { [key]: 100 } }));
      await expect(
        runPlatformPlansConfig(
          parsePlatformPlansArgs(['plans', 'set', 'free', '--file', file, '--yes']),
        ),
      ).rejects.toThrow();
      expect(calls.filter((call) => call.body)).toHaveLength(0);
    },
  );
  it('accepts the copied short-slug permission override only as a boolean', async () => {
    const file = join(directory, 'plan.json');
    await writeFile(file, JSON.stringify({ allowShortSlugs: true }));
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'set', 'free', '--file', file, '--plan', '--json']),
    );
    expect(calls.at(-1)?.body).toEqual({ allowShortSlugs: true, dryRun: true });
    await writeFile(file, JSON.stringify({ allowShortSlugs: 'true' }));
    await expect(
      runPlatformPlansConfig(
        parsePlatformPlansArgs(['plans', 'set', 'free', '--file', file, '--yes']),
      ),
    ).rejects.toThrow('must be a boolean');
    expect(calls.filter((call) => call.body)).toHaveLength(1);
  });
  it('requires explicit headless application before sending a preview', async () => {
    await expect(
      runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'archive', 'free'])),
    ).rejects.toThrow('--yes or --plan');
    expect(calls.filter((call) => call.body)).toHaveLength(0);
  });
  it('archives reversibly and removes with an explicit replacement', async () => {
    await runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'restore', 'free', '--yes']));
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'remove', 'free', '--replacement', 'custom', '--yes']),
    );
    expect(calls.filter((call) => call.body && !call.body.dryRun).map((call) => call.body)).toEqual(
      [
        { archived: false, expectedRevision: 7 },
        { replacementPlanId: 'custom', expectedRevision: 7 },
      ],
    );
  });
  it('reports pending updates as failure with a visible resumption command', async () => {
    pending = true;
    await expect(
      runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'sync', '--yes', '--json'])),
    ).rejects.toMatchObject({ code: 'plan_sync_pending' });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)?.url).toBe('https://api.example.com/operator/v1/config/plans/sync');
  });
  it('makes interactive limit selection readable and previews changes before confirmation', async () => {
    vi.stubGlobal('process', { ...process, stdin: { ...process.stdin, isTTY: true } });
    vi.mocked(select).mockResolvedValueOnce('requestsPerMonth');
    vi.mocked(text).mockResolvedValueOnce('10000000');
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'set', 'free']));
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            value: 'requestsPerMonth',
            label: 'Requests per billing month: 3,000,000',
          }),
        ]),
      }),
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Requests per billing month (0 means unlimited):' }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)?.body).toEqual({
      limits: { requestsPerMonth: 10_000_000 },
      expectedRevision: 7,
    });
  });
  it('rejects a stale interactive preview without retrying the change', async () => {
    vi.stubGlobal('process', { ...process, stdin: { ...process.stdin, isTTY: true } });
    vi.mocked(confirm).mockImplementationOnce(async () => {
      revision = 8;
      return true;
    });
    await expect(
      runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'archive', 'free'])),
    ).rejects.toMatchObject({ status: 409, code: 'revision_conflict' });
    expect(calls.filter((call) => call.body)).toHaveLength(2);
    expect(calls.at(-1)?.body).toEqual({ archived: true, expectedRevision: 7 });
  });
  it('continues successful batches with one confirmation and the exact committed policy revision', async () => {
    vi.stubGlobal('process', { ...process, stdin: { ...process.stdin, isTTY: true } });
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const before = { ...createDefaultPlanCatalog(), revision: 7 };
    const saved = {
      ...before,
      revision: 8,
      reconciliation: { revision: 8, planIds: ['free'], cursor: 'a', complete: false },
    };
    const next = { ...saved, reconciliation: { ...saved.reconciliation, cursor: 'b' } };
    const complete = { ...next, reconciliation: { ...next.reconciliation, complete: true } };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ catalog: before, accounts: [{ planId: 'free', count: 50 }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          dryRun: true,
          action: 'plans.reset',
          target: 'free',
          expectedRevision: 7,
          catalog: saved,
          affectedAccounts: 50,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          action: 'plans.reset',
          target: 'free',
          catalog: saved,
          affectedAccounts: 50,
          reconciliation: { complete: false, processed: 25 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ catalog: next, reconciliation: { complete: false, processed: 25 } }),
      )
      .mockResolvedValueOnce(
        Response.json({ catalog: complete, reconciliation: { complete: true, processed: 0 } }),
      );
    vi.stubGlobal('fetch', fetcher);
    await runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'reset', 'free']));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(
      fetcher.mock.calls
        .slice(3)
        .map(([input, init]) => ({ url: input.toString(), body: JSON.parse(String(init?.body)) })),
    ).toEqual([
      {
        url: 'https://api.example.com/operator/v1/config/plans/sync',
        body: { expectedRevision: 8 },
      },
      {
        url: 'https://api.example.com/operator/v1/config/plans/sync',
        body: { expectedRevision: 8 },
      },
    ]);
    expect(console.log).not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledExactlyOnceWith(
      `\n${pc.green('✓ Saved plans.reset free. Account updates complete.')}`,
      { withGuide: false },
    );
  });
});

describe('platform config plans AI logging defaults', () => {
  const catalog = { ...createDefaultPlanCatalog('free'), revision: 7 };
  const aiLogging = { modes: { pro: 'metadata' }, publish: null, remaining: 0 };

  /** A platform that answers each request from `answer`, recording request bodies. */
  function platform(answer: (url: string, body?: Record<string, unknown>) => unknown) {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      return Response.json(answer(url, body));
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  function output() {
    return vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
  }

  async function planFile(content: unknown) {
    const file = join(directory, 'plan.json');
    await writeFile(file, JSON.stringify(content));
    return file;
  }

  it('refuses aiLogging before any request on a platform without plan defaults', async () => {
    platform(() => ({ catalog, accounts: [] }));
    const file = await planFile({ aiLogging: 'off' });
    await expect(
      runPlatformPlansConfig(
        parsePlatformPlansArgs(['plans', 'set', 'pro', '--file', file, '--yes']),
      ),
    ).rejects.toThrow('Upgrade the platform first');
    expect(calls.filter((call) => call.body)).toHaveLength(0);
  });

  it('previews the change from the default the dry run read, with the project count', async () => {
    platform((_url, body) =>
      body
        ? {
            dryRun: true,
            action: 'plans.set',
            target: 'pro',
            expectedRevision: 7,
            catalog: { ...catalog, revision: 8 },
            affectedAccounts: 3,
            // Newer than the cached listing, which still says metadata.
            aiLogging: {
              modes: {},
              modesBefore: { pro: 'off' },
              planIds: ['pro'],
              includeUnknown: false,
            },
            aiLoggingPublish: { complete: false, processed: 0, remaining: 12, expectedBy: null },
          }
        : { catalog, accounts: [], aiLogging },
    );
    const file = await planFile({ aiLogging: 'inherit' });
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'set', 'pro', '--file', file, '--plan']),
    );
    expect(calls.at(-1)?.body).toEqual({ aiLogging: 'inherit', dryRun: true });
    expect(output()).toContain('AI Gateway logging: off → inherit');
    expect(output()).toContain('AI logging settings to publish: 12 projects');
  });

  it('offers the setting in the interactive picker', async () => {
    vi.stubGlobal('process', { ...process, stdin: { ...process.stdin, isTTY: true } });
    platform((_url, body) =>
      body?.dryRun
        ? { dryRun: true, expectedRevision: 7, catalog, affectedAccounts: 0, aiLogging }
        : body
          ? {
              catalog,
              reconciliation: { complete: true, processed: 0 },
              aiLoggingPublish: { complete: true, processed: 0, remaining: 0, expectedBy: null },
            }
          : { catalog, accounts: [], aiLogging },
    );
    vi.mocked(select).mockResolvedValueOnce('aiLogging').mockResolvedValueOnce('off');
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'set', 'pro']));
    expect(select).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        options: expect.arrayContaining([
          { value: 'aiLogging', label: 'AI Gateway logging: metadata' },
        ]),
      }),
    );
    expect(select).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ initialValue: 'metadata' }),
    );
    expect(calls.at(-1)?.body).toEqual({ aiLogging: 'off', expectedRevision: 7 });
  });

  it('keeps syncing until the AI logging publish completes, then prints the expected time', async () => {
    const pages = [
      { complete: false, processed: 100, remaining: 150, expectedBy: '2026-11-13T14:01:00.000Z' },
      { complete: false, processed: 100, remaining: 50, expectedBy: '2026-11-13T14:02:00.000Z' },
      { complete: true, processed: 50, remaining: 0, expectedBy: '2026-11-13T14:03:20.000Z' },
    ];
    platform((url, body) => {
      if (!body) {
        return { catalog, accounts: [], aiLogging };
      }
      if (body.dryRun) {
        return {
          dryRun: true,
          action: 'plans.set',
          target: 'pro',
          expectedRevision: 7,
          catalog: { ...catalog, revision: 8 },
          affectedAccounts: 0,
          aiLogging: { modes: { pro: 'off' }, planIds: ['pro'], includeUnknown: false },
        };
      }
      return {
        ...(url.endsWith('/sync') ? {} : { action: 'plans.set', target: 'pro' }),
        catalog: { ...catalog, revision: 8 },
        reconciliation: { complete: true, processed: 0 },
        aiLoggingPublish: pages.shift(),
      };
    });
    const file = await planFile({ aiLogging: 'off' });
    await runPlatformPlansConfig(
      parsePlatformPlansArgs(['plans', 'set', 'pro', '--file', file, '--yes']),
    );
    expect(calls.filter((call) => call.url.endsWith('/sync'))).toEqual([
      {
        url: 'https://api.example.com/operator/v1/config/plans/sync',
        body: { expectedRevision: 8 },
      },
      {
        url: 'https://api.example.com/operator/v1/config/plans/sync',
        body: { expectedRevision: 8 },
      },
    ]);
    expect(output()).toContain(
      'AI logging published to 250 projects; expected by 14:03:20 UTC (normally within 2 minutes).',
    );
  });

  it('stops with a resumption command when the AI logging publish fails', async () => {
    platform((_url, body) =>
      !body
        ? { catalog, accounts: [], aiLogging }
        : body.dryRun
          ? { dryRun: true, expectedRevision: 7, catalog, affectedAccounts: 0 }
          : {
              action: 'plans.set',
              target: 'pro',
              catalog: { ...catalog, revision: 8 },
              reconciliation: { complete: true, processed: 0 },
              aiLoggingPublish: { complete: false, processed: 0, remaining: 3, error: 'KV failed' },
              // The API marks a failed publish page this way; the CLI must still name plans sync.
              ok: false,
            },
    );
    const file = await planFile({ aiLogging: 'off' });
    await expect(
      runPlatformPlansConfig(
        parsePlatformPlansArgs(['plans', 'set', 'pro', '--file', file, '--yes']),
      ),
    ).rejects.toMatchObject({
      code: 'plan_sync_pending',
      message: expect.stringContaining('AI logging setting is not published to every project'),
    });
  });

  it('shows the plan default and a pending publish', async () => {
    platform((url) =>
      url.endsWith('/config/plans')
        ? { catalog, accounts: [], aiLogging }
        : {
            catalogRevision: 7,
            default: false,
            plan: catalog.plans.find((plan) => plan.id === 'pro'),
            accounts: 2,
            aiLogging: 'metadata',
            aiLoggingPublish: { complete: false, remaining: 4, planIds: ['pro'] },
          },
    );
    await runPlatformPlansConfig(parsePlatformPlansArgs(['plans', 'show', 'pro']));
    expect(output()).toContain('AI Gateway logging: metadata');
    expect(output()).toContain('AI logging publish pending: 4 projects remaining');
  });
});
