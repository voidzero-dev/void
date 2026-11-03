import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeCloudflareVersionMessage,
  type CloudflareOperation,
  type CloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  recordInstallationResource,
  type InstallationResourceKind,
  type PlatformInstallationManifest,
} from '@void/platform';
import { getPlatformRuntimeDirectory, resolvePlatformRuntime } from '@void/platform/installer';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return { ...actual, confirm: vi.fn(), log: { ...actual.log, step: vi.fn() }, note: vi.fn() };
});

// Record the waits before a read is done again, and do not wait.
const wait = vi.hoisted(() => vi.fn(async (_milliseconds: number) => {}));
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: wait,
}));

import { confirm, log, note } from '@voidzero-dev/vite-plus-prompts';
import {
  PlatformCloudflareApiError,
  PlatformCloudflareClient,
} from '../../src/cli/platform-cloudflare.ts';
import {
  recordWorkerCutoverResolution,
  recordWorkerCutoverStage,
  recordWorkerSecretUpdateState,
} from '../../src/cli/platform-installer-cutover.ts';
import {
  findPlatformWorkerOutsideChanges,
  reviewPlatformWorkerOutsideChanges,
  uploadPlatformWorkerOutsideChanges,
  type PlatformOutsideChangeInstallation,
  type PlatformWorkerOutsideChange,
} from '../../src/cli/platform-installer-outside-changes.ts';
import {
  deployPlatformWorker,
  type runPlatformWrangler,
} from '../../src/cli/platform-installer-workers.ts';
import type {
  PlatformInstallPlan,
  PlatformInstallPlanAction,
} from '../../src/cli/platform-plan.ts';

const runtime = resolvePlatformRuntime(getPlatformRuntimeDirectory());
const deployment = createPlatformDeploymentManifest({
  application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
  displayName: 'Example',
  installationSlug: 'example',
});
const names = deployment.resources;

function installationManifest(): PlatformInstallationManifest {
  let manifest = createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-10-15T00:00:00.000Z',
    deployment,
    id: 'example-a1b2c3d4',
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.1.10',
  });
  for (const [key, kind] of [
    ['hyperdrive', 'hyperdrive'],
    ['isr-cache-kv', 'kv-namespace'],
    ['legacy-assets-kv', 'kv-namespace'],
    ['routing-kv', 'kv-namespace'],
  ] as const satisfies ReadonlyArray<readonly [string, InstallationResourceKind]>) {
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: `${key}-id`,
        key,
        kind,
        name: key,
        ownership: 'created',
        state: 'ready',
      },
      '2026-10-15T00:00:01.000Z',
    );
  }
  return manifest;
}

function worker(
  key: string,
  name: string,
  action: PlatformInstallPlanAction['action'] = 'update',
): PlatformInstallPlanAction {
  return { action, id: null, key, kind: 'worker', name, reason: 'installed' };
}

function installPlan(actions: ReadonlyArray<PlatformInstallPlanAction>): PlatformInstallPlan {
  return {
    account: { id: 'account', name: 'Account' },
    actions,
    apiUrl: 'https://api.example.com',
    deployment,
    installationId: 'example-a1b2c3d4',
    proxyUrl: 'https://proxy.example.com',
    workersSubdomain: 'example',
    zone: null,
  };
}

const allWorkers = [
  worker('api-worker', names.apiWorker),
  worker('proxy-worker', names.proxyWorker),
  worker('email-gateway-worker', names.emailGatewayWorker),
  worker('tail-worker', names.tailWorker),
  worker('dispatch-worker', names.dispatchWorker),
];

// An installation without a stopped Worker cutover.
const installed: PlatformOutsideChangeInstallation = { manifest: installationManifest() };

const triggers: CloudflareTriggerConfig = {
  workers_dev: true,
  preview_urls: false,
  routes: [],
  crons: [],
  queueConsumers: [],
  workflows: [],
};
// Every version that Void deploys has this record of its triggers.
const recordedMessage = encodeCloudflareVersionMessage([], triggers);

/** Cloudflare API answers for a Worker whose active version has the given message. */
function activeVersionReads(
  workerName: string,
  message: string | undefined,
  ownershipMarker = 'owned-by-test',
) {
  const versionId = '22222222-2222-4222-8222-222222222222';
  const script = `/accounts/account/workers/scripts/${workerName}`;
  return vi.fn(async (path: string): Promise<unknown> => {
    if (path === `${script}/deployments`) {
      return {
        deployments: [
          {
            id: 'deployment',
            created_on: '2026-10-15T00:00:00.000Z',
            versions: [{ version_id: versionId, percentage: 100 }],
          },
        ],
      };
    }
    if (path === `${script}/versions/${versionId}`) {
      return {
        annotations: message === undefined ? {} : { 'workers/message': message },
        resources: {
          bindings: [
            { name: 'PLATFORM_OWNERSHIP_MARKER', type: 'plain_text', text: ownershipMarker },
          ],
        },
      };
    }
    throw new Error(`unexpected read ${path}`);
  });
}

describe('Worker change source', () => {
  const client = (response: () => Response) => {
    const paths: Array<string> = [];
    return {
      paths,
      client: new PlatformCloudflareClient('operator-token', {
        apiBase: 'https://cloudflare.example.test/client/v4',
        fetcher: async (input) => {
          paths.push(new URL(String(input)).pathname);
          return response();
        },
      }),
    };
  };

  it('reads where the last change to a Worker came from', async () => {
    const reader = client(() =>
      Response.json({
        success: true,
        result: { default_environment: { script: { last_deployed_from: 'dash' } } },
      }),
    );
    await expect(reader.client.getWorkerLastDeployedFrom('account', 'void-a-api')).resolves.toBe(
      'dash',
    );
    expect(reader.paths).toEqual(['/client/v4/accounts/account/workers/services/void-a-api']);
  });

  it('returns null when Cloudflare does not report the source', async () => {
    const reader = client(() =>
      Response.json({ success: true, result: { default_environment: { script: {} } } }),
    );
    await expect(reader.client.getWorkerLastDeployedFrom('account', 'void-a-api')).resolves.toBe(
      null,
    );
  });

  it('returns null for a Worker that does not exist', async () => {
    const reader = client(() =>
      Response.json(
        {
          success: false,
          result: null,
          errors: [{ code: 10090, message: 'This Worker does not exist on this account.' }],
        },
        { status: 404 },
      ),
    );
    await expect(reader.client.getWorkerLastDeployedFrom('account', 'void-a-api')).resolves.toBe(
      null,
    );
  });

  it('reports other failed reads', async () => {
    const reader = client(() =>
      Response.json(
        { success: false, errors: [{ code: 10000, message: 'Internal error' }] },
        { status: 500 },
      ),
    );
    await expect(
      reader.client.getWorkerLastDeployedFrom('account', 'void-a-api'),
    ).rejects.toBeInstanceOf(PlatformCloudflareApiError);
  });
});

describe('platform Workers changed outside Void', () => {
  const sources = new Map<string, string | null>();
  const getWorkerLastDeployedFrom = vi.fn(
    async (_account: string, name: string) => sources.get(name) ?? 'cf_cli',
  );
  // The message of each Worker's active version. By default, Void deployed it.
  const activeMessages = new Map<string, string | undefined>();
  const readCloudflare = vi.fn(async (path: string): Promise<unknown> => {
    const name = /\/workers\/scripts\/([^/]+)\//.exec(path)?.[1] ?? '';
    const message = activeMessages.has(name) ? activeMessages.get(name) : recordedMessage;
    return activeVersionReads(name, message)(path);
  });
  const client = {
    getWorkerLastDeployedFrom,
    request: async <T>(path: string) => (await readCloudflare(path)) as T,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sources.clear();
    activeMessages.clear();
  });

  it('reads only existing Workers that the run uploads and flags dashboard and API changes', async () => {
    sources.set(names.apiWorker, 'dash');
    sources.set(names.proxyWorker, 'api');
    sources.set(names.tailWorker, null);
    const plan = installPlan([
      ...allWorkers.slice(0, 4),
      worker('dispatch-worker', names.dispatchWorker, 'reuse'),
      worker('extra-worker', 'void-example-other', 'create'),
    ]);

    await expect(
      findPlatformWorkerOutsideChanges(client, plan, runtime, installed),
    ).resolves.toEqual([
      { key: 'api', name: names.apiWorker, source: 'dash' },
      { key: 'proxy', name: names.proxyWorker, source: 'api' },
    ]);
    expect(getWorkerLastDeployedFrom.mock.calls.map(([, name]) => name)).toEqual(
      runtime.manifest.artifacts.emailGateway
        ? [
            names.apiWorker,
            names.proxyWorker,
            names.emailGatewayWorker,
            names.tailWorker,
            names.dispatchWorker,
          ]
        : [names.apiWorker, names.proxyWorker, names.tailWorker, names.dispatchWorker],
    );
  });

  it('also flags an existing Worker whose active version has no Void record of its triggers', async () => {
    // A run stopped after the Cloudflare CLI replaced the change, before Void
    // deployed its own version. The marker shows the Cloudflare CLI.
    activeMessages.set(names.proxyWorker, undefined);
    // Void wrote this older record, which has no triggers. The upgrade refuses it too.
    sources.set(names.tailWorker, null);
    activeMessages.set(names.tailWorker, 'void:{"schema":1,"migrations":[]}');
    // The marker already shows the change, so the version is not read. The
    // deployments are read: the deploy needs one active version.
    sources.set(names.apiWorker, 'dash');
    activeMessages.set(names.apiWorker, undefined);

    await expect(
      findPlatformWorkerOutsideChanges(client, installPlan(allWorkers), runtime, installed),
    ).resolves.toEqual([
      { key: 'api', name: names.apiWorker, source: 'dash' },
      { key: 'proxy', name: names.proxyWorker, source: 'unrecorded' },
      { key: 'tail', name: names.tailWorker, source: 'unrecorded' },
    ]);
    const reads = readCloudflare.mock.calls.map(([path]) => path);
    expect(reads.filter((path) => path.includes(`/${names.apiWorker}/`))).toEqual([
      `/accounts/account/workers/scripts/${names.apiWorker}/deployments`,
    ]);
    expect(reads.filter((path) => path.includes(`/${names.proxyWorker}/`))).toEqual([
      `/accounts/account/workers/scripts/${names.proxyWorker}/deployments`,
      `/accounts/account/workers/scripts/${names.proxyWorker}/versions/22222222-2222-4222-8222-222222222222`,
    ]);
  });

  it('does not read Workers that the run creates', async () => {
    const plan = installPlan(allWorkers.map((action) => worker(action.key, action.name, 'create')));
    await expect(
      findPlatformWorkerOutsideChanges(client, plan, runtime, installed),
    ).resolves.toEqual([]);
    expect(getWorkerLastDeployedFrom).not.toHaveBeenCalled();
  });

  it('skips an email gateway that the runtime does not include', async () => {
    sources.set(names.emailGatewayWorker, 'dash');
    const { emailGateway: _, ...artifacts } = runtime.manifest.artifacts;
    const withoutGateway = { ...runtime, manifest: { ...runtime.manifest, artifacts } };
    await expect(
      findPlatformWorkerOutsideChanges(client, installPlan(allWorkers), withoutGateway, installed),
    ).resolves.toEqual([]);
    expect(getWorkerLastDeployedFrom.mock.calls.map(([, name]) => name)).not.toContain(
      names.emailGatewayWorker,
    );
  });

  describe('when Void cannot read a Worker', () => {
    type Read = 'source' | 'deployments' | 'version';
    const failure = (status: number) => new PlatformCloudflareApiError('Cloudflare error', status);
    const notReadable = (answer: string) =>
      `platform: Void cannot read the platform Worker ${names.apiWorker} (${answer}), so it cannot find changes made outside Void. No platform Worker changed. This command did not pause application traffic.`;
    /** Each read takes the next answer of its kind, then the answer of a Worker that Void deployed. */
    const find = (answers: Partial<Record<Read, Array<unknown>>>) => {
      const reads: Array<Read> = [];
      const recorded = activeVersionReads(names.apiWorker, recordedMessage);
      const answer = async (read: Read, otherwise: () => Promise<unknown>) => {
        reads.push(read);
        const next = answers[read]?.length ? answers[read].shift() : otherwise;
        if (next instanceof Error) {
          throw next;
        }
        return typeof next === 'function' ? (next as () => Promise<unknown>)() : next;
      };
      return {
        reads,
        result: findPlatformWorkerOutsideChanges(
          {
            getWorkerLastDeployedFrom: async () =>
              (await answer('source', async () => 'cf_cli')) as string | null,
            request: async <T>(path: string) =>
              (await answer(path.endsWith('/deployments') ? 'deployments' : 'version', () =>
                recorded(path),
              )) as T,
          },
          installPlan([worker('api-worker', names.apiWorker)]),
          runtime,
          installed,
        ),
      };
    };

    it.each([
      {
        name: 'Cloudflare refuses the token',
        answers: { source: [failure(403)] },
        reads: ['source'],
        waits: [],
        message: `${notReadable('HTTP 403')} Make sure that the Cloudflare API token has Account → Workers Scripts → Edit for this account. Then run the command again.`,
      },
      {
        name: 'Cloudflare fails three times',
        answers: { source: [failure(500), failure(502), failure(500)] },
        reads: ['source', 'source', 'source'],
        waits: [[250], [500]],
        message: `${notReadable('HTTP 500')} Run the command again.`,
      },
      {
        name: 'the network fails three times',
        answers: { deployments: [1, 2, 3].map(() => new TypeError('fetch failed')) },
        reads: ['source', 'deployments', 'deployments', 'deployments'],
        waits: [[250], [500]],
        message: `${notReadable('no HTTP response: fetch failed')} Run the command again.`,
      },
      {
        name: 'the version read fails',
        answers: { version: [failure(404)] },
        reads: ['source', 'deployments', 'version'],
        waits: [],
        message: `${notReadable('HTTP 404')} Run the command again.`,
      },
      {
        name: 'the deployment data is malformed',
        answers: { deployments: [{ deployments: [{ versions: [{ percentage: 100 }] }] }] },
        reads: ['source', 'deployments'],
        waits: [],
        message: `platform: Cloudflare returned malformed deployment data for the platform Worker ${names.apiWorker}, so Void cannot find changes made outside Void. No platform Worker changed. This command did not pause application traffic. Run the command again.`,
      },
      {
        // The deploy refuses this deployment after it paused traffic.
        name: 'no version gets all traffic',
        answers: {
          source: ['dash'],
          deployments: [
            {
              deployments: [
                {
                  versions: [
                    { version_id: '22222222-2222-4222-8222-222222222222', percentage: 90 },
                    { version_id: '33333333-3333-4333-8333-333333333333', percentage: 10 },
                  ],
                },
              ],
            },
          ],
        },
        reads: ['source', 'deployments'],
        waits: [],
        message: `platform: The platform Worker ${names.apiWorker} has no single version that gets 100% of traffic, for example after a gradual deployment. This command deploys a new version only when one version gets all traffic. No platform Worker changed. This command did not pause application traffic. In the Cloudflare dashboard, deploy one version of ${names.apiWorker} to 100% of traffic. Then run this command once in a terminal, so that you can approve the dashboard change.`,
      },
    ] satisfies ReadonlyArray<{
      name: string;
      answers: Partial<Record<Read, Array<unknown>>>;
      reads: ReadonlyArray<Read>;
      waits: ReadonlyArray<readonly [number]>;
      message: string;
    }>)('stops when $name', async ({ answers, reads, waits, message }) => {
      const found = find(answers);

      await expect(found.result).rejects.toThrow(message);
      expect(found.reads).toEqual(reads);
      // Void reads again only after a failure that can pass.
      expect(wait.mock.calls).toEqual(waits);
    });

    it('reads again after a rate limit and continues', async () => {
      const found = find({ source: [failure(429)] });

      await expect(found.result).resolves.toEqual([]);
      expect(found.reads).toEqual(['source', 'source', 'deployments', 'version']);
      expect(wait.mock.calls).toEqual([[250]]);
    });

    it('shows no change for a Worker that does not exist', async () => {
      // Cloudflare answers HTTP 404, and the source read then gives null.
      const found = find({ source: [null], deployments: [failure(404)] });

      await expect(found.result).resolves.toEqual([]);
      expect(found.reads).toEqual(['source', 'deployments']);
      expect(wait).not.toHaveBeenCalled();
    });

    it('keeps a change made outside Void when the deployments read gives 404', async () => {
      const found = find({ source: ['dash'], deployments: [failure(404)] });

      await expect(found.result).resolves.toEqual([
        { key: 'api', name: names.apiWorker, source: 'dash' },
      ]);
      expect(found.reads).toEqual(['source', 'deployments']);
    });
  });

  describe('after a run stopped during a Worker cutover', () => {
    const voidVersion = '22222222-2222-4222-8222-222222222222';
    const earlierVersion = '33333333-3333-4333-8333-333333333333';
    const earlierPath = `/accounts/account/workers/scripts/${names.apiWorker}/versions/${earlierVersion}`;
    let earlierMessage: string | undefined;
    const reads = vi.fn(async (path: string): Promise<unknown> =>
      path === earlierPath
        ? { annotations: earlierMessage === undefined ? {} : { 'workers/message': earlierMessage } }
        : readCloudflare(path),
    );
    const find = (installation: PlatformOutsideChangeInstallation) =>
      findPlatformWorkerOutsideChanges(
        { getWorkerLastDeployedFrom, request: async <T>(path: string) => (await reads(path)) as T },
        installPlan(allWorkers),
        runtime,
        installation,
      );
    // The run agreed to replace a change made outside Void on the API Worker.
    // It made Void's version active and stopped before the cutover finished.
    // The marker shows the Cloudflare CLI, and the active version has the record.
    const stopped = (manifest = installationManifest()) =>
      recordWorkerCutoverStage(
        manifest,
        1,
        'api',
        earlierVersion,
        voidVersion,
        names.apiWorker,
        triggers,
        '2026-10-15T00:00:02.000Z',
      );
    const authentication = (sessionsRequired: boolean) =>
      vi.fn(async () => ({ enabledProviders: [], protectedByAccess: false, sessionsRequired }));
    const earlierReads = () => reads.mock.calls.filter(([path]) => path === earlierPath);

    beforeEach(() => {
      reads.mockClear();
      earlierMessage = undefined;
    });

    it('flags a Worker when the run restores an earlier version without a Void record', async () => {
      // The installer restores the earlier version first, and then the upgrade
      // would refuse it.
      await expect(find({ manifest: stopped() })).resolves.toEqual([
        { key: 'api', name: names.apiWorker, source: 'unrecorded' },
      ]);
      // The active and the earlier version are read at the same time.
      expect(
        reads.mock.calls
          .map(([path]) => path)
          .filter((path) => path.includes(names.apiWorker))
          .sort(),
      ).toEqual([
        `/accounts/account/workers/scripts/${names.apiWorker}/deployments`,
        `/accounts/account/workers/scripts/${names.apiWorker}/versions/${voidVersion}`,
        earlierPath,
      ]);
      // The other Workers have no staged version, so they get no extra read.
      expect(reads).toHaveBeenCalledTimes(
        (runtime.manifest.artifacts.emailGateway ? 5 : 4) * 2 + 1,
      );

      // Without an open cutover, the run restores nothing.
      reads.mockClear();
      for (const resolution of ['committed', 'restored'] as const) {
        await expect(
          find({
            manifest: recordWorkerCutoverResolution(
              stopped(),
              1,
              resolution,
              '2026-10-15T00:00:03.000Z',
            ),
          }),
        ).resolves.toEqual([]);
      }
      await expect(find(installed)).resolves.toEqual([]);
      expect(earlierReads()).toEqual([]);
    });

    it('does not flag an earlier version that has the record', async () => {
      earlierMessage = recordedMessage;
      await expect(find({ manifest: stopped() })).resolves.toEqual([]);
      expect(earlierReads()).toHaveLength(1);
    });

    it('does not inspect old secret versions when resuming a credential update', async () => {
      await expect(
        find({
          manifest: recordWorkerSecretUpdateState(
            stopped(),
            1,
            'pending',
            'rotation',
            '2026-10-23T00:00:00.000Z',
          ),
        }),
      ).resolves.toEqual([]);
      expect(earlierReads()).toEqual([]);
    });

    it('decides like the installer whether the run restores the earlier version', async () => {
      const configurable = (manifest: PlatformInstallationManifest) => ({
        ...manifest,
        deployment: {
          ...manifest.deployment,
          authentication: { ...manifest.deployment.authentication, configurable: true as const },
        },
      });
      // While the platform changes to configurable sign-in and already requires
      // sign-in, the installer keeps Void's version.
      const required = authentication(true);
      await expect(
        find({ manifest: stopped(), readAuthenticationState: required }),
      ).resolves.toEqual([]);
      expect(required).toHaveBeenCalledOnce();
      expect(earlierReads()).toEqual([]);

      const flagged = [{ key: 'api', name: names.apiWorker, source: 'unrecorded' }];
      const notRequired = authentication(false);
      await expect(
        find({ manifest: stopped(), readAuthenticationState: notRequired }),
      ).resolves.toEqual(flagged);
      // An installation with configurable sign-in always restores, so the
      // database is not read.
      const unread = authentication(true);
      await expect(
        find({
          manifest: stopped(configurable(installationManifest())),
          readAuthenticationState: unread,
        }),
      ).resolves.toEqual(flagged);
      expect(unread).not.toHaveBeenCalled();
      // Without the database read, expect the restore.
      await expect(find({ manifest: stopped() })).resolves.toEqual(flagged);
    });
  });

  describe('review before a run', () => {
    const review = (interactive: boolean) =>
      reviewPlatformWorkerOutsideChanges({
        client,
        plan: installPlan(allWorkers),
        runtime,
        installation: installed,
        interactive,
        command: 'void platform upgrade example-a1b2c3d4',
      });

    it('changes nothing when no Worker was changed outside Void', async () => {
      await expect(review(true)).resolves.toEqual([]);
      expect(confirm).not.toHaveBeenCalled();
    });

    it('stops without a terminal and names each Worker and the source of its change', async () => {
      sources.set(names.apiWorker, 'dash');
      activeMessages.set(names.proxyWorker, undefined);
      sources.set(names.tailWorker, 'api');
      await expect(review(false)).rejects.toThrow(
        [
          // An older Void release can have deployed the active version, so
          // the heading does not say that each Worker was changed outside Void.
          'platform: These platform Workers need your approval before this command replaces their configuration:',
          `${names.apiWorker}: changed in the Cloudflare dashboard`,
          `${names.proxyWorker}: has an active version without a Void deployment record`,
          `${names.tailWorker}: changed in the Cloudflare API`,
          // An earlier run can have paused traffic. This one did not. The
          // lifecycle lock can have changed the database.
          'No platform Worker changed. This command did not pause application traffic.',
          'This command replaces their configuration with the Void configuration. It can ask for your approval only in a terminal.',
          'Run this command once in a terminal to review them:',
          'void platform upgrade example-a1b2c3d4',
        ].join('\n'),
      );
      expect(confirm).not.toHaveBeenCalled();
    });

    it('stops when the operator does not agree', async () => {
      sources.set(names.apiWorker, 'api');
      vi.mocked(confirm).mockResolvedValueOnce(false);
      await expect(review(true)).rejects.toThrow(
        'platform: Cancelled. No platform Worker changed. This command did not pause application traffic.',
      );
      expect(confirm).toHaveBeenCalledWith({
        message: 'Replace the configuration of these Workers?',
        initialValue: false,
      });
    });

    it('returns the Workers that the operator agreed to replace and uploads nothing yet', async () => {
      sources.set(names.apiWorker, 'api');
      vi.mocked(confirm).mockResolvedValueOnce(true);

      await expect(review(true)).resolves.toEqual([
        { key: 'api', name: names.apiWorker, source: 'api' },
      ]);

      const shown = String(vi.mocked(note).mock.calls[0]?.[0]);
      expect(vi.mocked(note).mock.calls[0]?.[1]).toBe('Approval needed');
      expect(shown).toContain(`${names.apiWorker}: changed in the Cloudflare API`);
      expect(shown).toContain(
        'First, it prepares the platform resources and the database.\nThen, before it pauses traffic or deploys a Worker, the Cloudflare CLI asks you again for each Worker changed in the Cloudflare dashboard or API.',
      );
      expect(shown).toContain(
        'It uploads a new version of each of these Workers and does not deploy it.',
      );
      // The installer uploads later. Here the source is read once, to find the change.
      expect(
        getWorkerLastDeployedFrom.mock.calls.filter(([, name]) => name === names.apiWorker),
      ).toHaveLength(1);
    });

    it('does not say that the Cloudflare CLI asks when no marker shows a change', async () => {
      activeMessages.set(names.apiWorker, undefined);
      vi.mocked(confirm).mockResolvedValueOnce(true);

      await expect(review(true)).resolves.toEqual([
        { key: 'api', name: names.apiWorker, source: 'unrecorded' },
      ]);

      const shown = String(vi.mocked(note).mock.calls[0]?.[0]);
      expect(shown).toBe(
        [
          `${names.apiWorker}: has an active version without a Void deployment record`,
          '',
          'This command replaces the configuration of these Workers with the Void configuration.',
          'It removes values that Void does not set, for example an EMAIL_FROM that you added.',
          'It resets values that Void sets, for example AUTH_REDIRECT_URI.',
        ].join('\n'),
      );
    });
  });

  describe('upload after the operator agrees', () => {
    const installation = installationManifest();
    const activeVersion = '11111111-1111-4111-8111-111111111111';
    const ownershipMarker = JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: 'account',
        installationId: installation.id,
        ownershipNonce: installation.ownershipNonce,
        resourceId: names.apiWorker,
        resourceKey: 'api-worker',
        resourceKind: 'worker',
        resourceName: names.apiWorker,
      }),
    );
    // The installer gives this config. A run can create a resource that it uses.
    const config = {
      account_id: 'account',
      compatibility_date: '2026-09-30',
      kv_namespaces: [{ binding: 'ISR_CACHE', id: 'isr-cache-created-in-run' }],
      main: `${runtime.directory}/${runtime.manifest.artifacts.api.path}`,
      name: names.apiWorker,
      routes: [{ pattern: 'api.example.com', custom_domain: true }],
      vars: { PLATFORM_OWNERSHIP_MARKER: ownershipMarker },
      workers_dev: true,
    };
    // The active version of a Worker changed with the Workers API has no Void message.
    const request = vi.fn(async (path: string): Promise<unknown> => {
      if (path.endsWith('/deployments')) {
        return {
          deployments: [
            {
              id: 'deployment',
              created_on: '2026-10-15T00:00:00.000Z',
              versions: [{ version_id: activeVersion, percentage: 100 }],
            },
          ],
        };
      }
      if (path.endsWith(`/versions/${activeVersion}`)) {
        return {
          annotations: { 'workers/triggered_by': 'upload' },
          resources: {
            bindings: [
              { name: 'PLATFORM_OWNERSHIP_MARKER', type: 'plain_text', text: ownershipMarker },
            ],
          },
        };
      }
      throw new Error(`unexpected read ${path}`);
    });
    const events: Array<string> = [];
    const uploads: Array<{
      operation: Parameters<typeof runPlatformWrangler>[0];
      config: Record<string, unknown>;
    }> = [];
    const runner = vi.fn<typeof runPlatformWrangler>(async (operation) => {
      events.push('upload');
      uploads.push({
        operation,
        config: JSON.parse(readFileSync(String(operation.configPath), 'utf8')),
      });
      return { status: 0, stdout: '', stderr: '' };
    });
    const progress = {
      pause: vi.fn(() => {
        events.push('pause');
      }),
      resume: vi.fn(() => {
        events.push('resume');
      }),
    };
    const upload = (
      changes: ReadonlyArray<PlatformWorkerOutsideChange> = [
        { key: 'api', name: names.apiWorker, source: 'api' },
      ],
    ) =>
      uploadPlatformWorkerOutsideChanges([config], {
        changes,
        client: {
          apiBaseUrl: 'https://cloudflare.example.test',
          getWorkerLastDeployedFrom: async (account, name) => {
            events.push('read');
            return getWorkerLastDeployedFrom(account, name);
          },
          request: async <T>(path: string) => (await request(path)) as T,
        },
        operatorApiToken: 'operator-token',
        progress,
        runner,
      });

    beforeEach(() => {
      events.length = 0;
      uploads.length = 0;
    });

    it('stops the progress display while the Cloudflare CLI asks, and uploads without a deployment', async () => {
      sources.set(names.apiWorker, 'api');
      runner.mockImplementationOnce(async (operation) => {
        events.push('upload');
        uploads.push({
          operation,
          config: JSON.parse(readFileSync(String(operation.configPath), 'utf8')),
        });
        sources.set(names.apiWorker, 'cf_cli');
        return { status: 0, stdout: '', stderr: '' };
      });

      await upload();

      expect(events).toEqual(['pause', 'upload', 'read', 'resume']);
      expect(log.step).toHaveBeenCalledWith(
        `Uploading a new version of ${names.apiWorker} without deploying it`,
      );
      expect(uploads).toHaveLength(1);
      expect(uploads[0]!.operation).toEqual({
        type: 'versions.upload',
        configPath: expect.any(String),
        message: 'Void: replace changes made outside Void',
        interactive: true,
      });
      expect(runner.mock.calls[0]!.slice(1)).toEqual(['account', expect.any(String), true]);
      const { routes: _, ...uploaded } = config;
      expect(uploads[0]!.config).toEqual(uploaded);
    });

    it('stops when the Cloudflare CLI does not replace the change', async () => {
      sources.set(names.apiWorker, 'dash');

      await expect(upload()).rejects.toThrow(
        `platform: The Cloudflare CLI did not replace the changes to ${names.apiWorker}. Its output above shows why. No deployment changed. This command did not pause application traffic.`,
      );
      expect(runner).toHaveBeenCalledOnce();
      expect(events).toEqual(['pause', 'upload', 'read', 'resume']);
    });

    it('uploads nothing for a version that the Cloudflare CLI does not ask about', async () => {
      // The deploy replaces this version. The marker shows the Cloudflare CLI,
      // so the Cloudflare CLI would not ask.
      await upload([{ key: 'api', name: names.apiWorker, source: 'unrecorded' }]);

      expect(events).toEqual([]);
      expect(runner).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(log.step).not.toHaveBeenCalled();
    });

    it('stops when the Cloudflare CLI exits with an error', async () => {
      runner.mockResolvedValueOnce({ status: 1, stdout: '', stderr: '' });

      await expect(upload()).rejects.toThrow(
        `platform: The Cloudflare CLI did not replace the changes to ${names.apiWorker}.`,
      );
      expect(progress.resume).toHaveBeenCalledOnce();
    });
  });
});

describe('installer upload after the operator agrees', () => {
  const version = '11111111-1111-4111-8111-111111111111';

  async function deploy(
    replaceOutsideChanges: boolean,
    readCloudflare?: (path: string) => Promise<unknown>,
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'void-outside-change-'));
    const commands: Array<string> = [];
    try {
      const main = join(directory, 'worker.js');
      writeFileSync(main, 'export default { fetch() { return new Response("void"); } };');
      const config = {
        account_id: 'account',
        compatibility_date: '2026-09-30',
        main,
        name: 'void-test-api',
        vars: { PLATFORM_OWNERSHIP_MARKER: 'owned-by-test' },
        workers_dev: true,
      };
      const runner = async (operation: CloudflareOperation) => {
        commands.push(operation.type);
        switch (operation.type) {
          case 'deployments.status':
            return {
              status: 0,
              stdout: '',
              stderr: '',
              data: { versions: [{ percentage: 100, version_id: version }] },
            };
          case 'deployments.list':
            return {
              status: 0,
              stdout: '',
              stderr: '',
              data: [
                {
                  created_on: '2026-10-15T00:00:00.000Z',
                  id: 'deployment',
                  versions: [{ percentage: 100, version_id: version }],
                },
              ],
            };
          case 'versions.view':
            // A Workers API edit leaves no Void message on the active version.
            return {
              status: 0,
              stdout: '',
              stderr: '',
              data: {
                annotations: { 'workers/triggered_by': 'upload' },
                resources: {
                  bindings: [
                    {
                      name: 'PLATFORM_OWNERSHIP_MARKER',
                      type: 'plain_text',
                      text: 'owned-by-test',
                    },
                  ],
                },
              },
            };
          case 'versions.upload':
            return { status: 1, stdout: '', stderr: 'upload reached' };
          default:
            throw new Error(`Unexpected command: ${operation.type}`);
        }
      };
      const error = await deployPlatformWorker(
        config,
        { SECRET: 'value' },
        {
          apiBaseUrl: 'https://api.cloudflare.com/client/v4',
          inspectNewWorker: async () => 'owned',
          managedRoutes: [],
          onStaged: async () => {},
          onTrafficPublished: async () => {},
          onUnsafeTraffic: async () => {},
          preservedRoutes: [],
          previousConfig: config,
          previousPublicEndpoints: true,
          publishCustomDomains: async () => {},
          publishRoutes: async () => {},
          ...(readCloudflare ? { readCloudflare } : {}),
          retainNewWorker: async () => {},
          ...(replaceOutsideChanges ? { replaceOutsideChanges } : {}),
          runner,
          workerExisted: true,
        },
      ).then(
        () => null,
        (failure: unknown) => failure as Error,
      );
      return { commands, error };
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }

  it('refuses an active version without a Void record of its triggers', async () => {
    const { commands, error } = await deploy(false);
    expect(error?.message).toContain('predates safe trigger snapshots');
    expect(commands).not.toContain('versions.upload');
  });

  it("uses Void's own triggers when the operator agreed to replace the outside changes", async () => {
    const { commands, error } = await deploy(true);
    expect(error?.message).toContain('upload reached');
    expect(commands).toContain('versions.upload');
  });

  it('flags a Worker before a run exactly when the upgrade refuses its active version', async () => {
    const results = [];
    for (const message of [undefined, 'Edited', recordedMessage]) {
      // The check and the upgrade read the same Cloudflare API answers.
      const reads = activeVersionReads('void-test-api', message);
      const changes = await findPlatformWorkerOutsideChanges(
        {
          getWorkerLastDeployedFrom: async () => 'cf_cli',
          request: async <T>(path: string) => (await reads(path)) as T,
        },
        installPlan([worker('api-worker', 'void-test-api')]),
        runtime,
        installed,
      );
      const { error } = await deploy(false, reads);
      results.push({
        flagged: changes.map((change) => change.source),
        refused: error?.message.includes('predates safe trigger snapshots'),
      });
    }

    expect(results).toEqual([
      { flagged: ['unrecorded'], refused: true },
      { flagged: ['unrecorded'], refused: true },
      { flagged: [], refused: false },
    ]);
  });
});
