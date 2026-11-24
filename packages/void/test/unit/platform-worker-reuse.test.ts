import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import {
  encodeCloudflareVersionMessage,
  parseCloudflareVersionMessage,
  readCloudflareTriggerConfig,
} from '@void/deploy-cloudflare';
import { expect, it, vi } from 'vite-plus/test';
import { PlatformWorkerRecoveryIncompleteError } from '../../src/cli/platform-installer-types.ts';

// Record the waits before deployment history is read again, and do not wait.
const wait = vi.hoisted(() => vi.fn(async (_milliseconds: number) => {}));
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: wait,
}));

// A new Worker is created through the conditional-create proxy. Send it to the
// test runner instead of starting the Cloudflare CLI.
const conditionalCreate = vi.hoisted(() => ({
  runner: null as null | ((operation: CloudflareOperation) => Promise<unknown>),
}));
vi.mock('../../src/cli/platform-installer-process.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/platform-installer-process.ts')>()),
  runPlatformWranglerForConditionalCreate: async (operation: CloudflareOperation) =>
    conditionalCreate.runner!(operation),
}));
import {
  deployPlatformWorker,
  platformWorkerUploadFingerprint,
} from '../../src/cli/platform-installer-workers.ts';

const VERSION = '11111111-1111-4111-8111-111111111111';
const NEXT_VERSION = '22222222-2222-4222-8222-222222222222';

async function attemptReuse(input: {
  acquireUploadSlot?: () => Promise<(failure?: unknown) => void>;
  annotationHash?: string;
  missingAnnotationHash?: boolean;
  mutateScriptAtUpload?: boolean;
  onCommand?: (command: string) => void;
  onReadyForActivation?: () => Promise<void>;
  changeConfig?: boolean;
  changeScript?: boolean;
  directApi?: boolean;
  directDeploymentDrift?: boolean;
  directLateDeploymentDrift?: boolean;
  directProofDeploymentDrift?: boolean;
  directReadFailure?: boolean;
  liveTriggers?: boolean;
  postActivationHeads?: ReadonlyArray<
    'previous' | 'activated' | 'competing' | 'empty' | 'older' | Error
  >;
  reuseMatchingVersion?: boolean;
  secrets?: Record<string, string> | null;
  triggerFailure?: boolean;
  lateVersionDrift?: boolean;
  versionDrift?: boolean;
  waitForPriorWorker?: () => Promise<void>;
  workerExisted?: boolean;
}) {
  const workerExisted = input.workerExisted !== false;
  const directory = mkdtempSync(join(tmpdir(), 'void-worker-reuse-'));
  const calls: Array<string> = [];
  const onTrafficPublished = vi.fn(async () => {});
  const onUnsafeTraffic = vi.fn(async () => {});
  const retainNewWorker = vi.fn(async () => {});
  let uploadedScript: string | null = null;
  let uploadedHash: string | null = null;
  let expectedHash: string | null = null;
  try {
    const main = join(directory, 'worker.js');
    const configPath = join(directory, 'wrangler.json');
    const marker = 'owned-by-test';
    const config = {
      account_id: 'account',
      compatibility_date: '2026-09-30',
      main,
      name: 'void-test-api',
      preview_urls: false,
      vars: { PLATFORM_OWNERSHIP_MARKER: marker, VERSION: 'one' },
      workers_dev: true,
    };
    writeFileSync(main, 'export default { fetch() { return new Response("one"); } };');
    writeFileSync(configPath, JSON.stringify(config));
    const originalHash = platformWorkerUploadFingerprint(config);
    expect(originalHash).toMatch(/^[a-f0-9]{64}$/);
    expectedHash = originalHash;
    const triggers = readCloudflareTriggerConfig(configPath);
    if (input.changeScript) {
      writeFileSync(main, 'export default { fetch() { return new Response("two"); } };');
    }
    const desiredConfig = input.changeConfig
      ? { ...config, vars: { ...config.vars, VERSION: 'two' } }
      : config;
    const version = {
      annotations: {
        'workers/message': encodeCloudflareVersionMessage(
          [],
          triggers,
          input.missingAnnotationHash ? undefined : (input.annotationHash ?? originalHash!),
        ),
      },
      resources: {
        bindings: [{ name: 'PLATFORM_OWNERSHIP_MARKER', type: 'plain_text', text: marker }],
      },
    };
    const deployment = {
      created_on: '2026-09-30T00:00:00.000Z',
      id: 'deployment-one',
      versions: [{ percentage: 100, version_id: VERSION }],
    };
    // An earlier restoration that runs the same version, listed under the
    // previous deployment. A lagging read can return it at the head.
    const olderDeployment = {
      created_on: '2026-09-29T00:00:00.000Z',
      id: 'deployment-older',
      versions: [{ percentage: 100, version_id: VERSION }],
    };
    let directDeploymentReads = 0;
    const readCloudflare = vi.fn(async (path: string): Promise<unknown> => {
      if (input.directReadFailure) {
        throw new Error('Cloudflare API read unavailable');
      }
      if (path.endsWith('/deployments')) {
        directDeploymentReads++;
        return {
          deployments: [
            (input.directDeploymentDrift && directDeploymentReads > 1) ||
            (input.directProofDeploymentDrift && directDeploymentReads > 2) ||
            (input.directLateDeploymentDrift && directDeploymentReads > 4)
              ? { ...deployment, id: 'deployment-two' }
              : deployment,
          ],
        };
      }
      if (path.endsWith(`/versions/${VERSION}`)) {
        return version;
      }
      if (input.liveTriggers) {
        if (path.endsWith('/workers/workers/void-test-api')) {
          return {
            name: 'void-test-api',
            subdomain: { enabled: true, previews_enabled: false },
            references: { queues: [] },
          };
        }
        if (path.endsWith('/schedules')) {
          return { schedules: [] };
        }
        if (path.includes('/workflows?')) {
          return [];
        }
      }
      throw new Error(`Unexpected Cloudflare API read: ${path}`);
    });
    let statusReads = 0;
    let activated = false;
    let visibleVersionId = VERSION;
    let postActivationReads = 0;
    const runner = async (args: CloudflareOperation) => {
      calls.push(args.type);
      input.onCommand?.(calls.at(-1)!);
      if (args.type === 'deployments.status') {
        statusReads++;
        return {
          status: 0,
          stderr: '',
          stdout: '',
          data: {
            versions: [
              {
                percentage: 100,
                version_id:
                  (input.versionDrift && statusReads > 1) ||
                  (input.lateVersionDrift && statusReads > 4)
                    ? NEXT_VERSION
                    : visibleVersionId,
              },
            ],
          },
        };
      }
      if (args.type === 'versions.view') {
        return {
          status: 0,
          stderr: '',
          stdout: '',
          data: version,
        };
      }
      if (args.type === 'deployments.list') {
        let data = !workerExisted
          ? []
          : input.postActivationHeads?.includes('older')
            ? [deployment, olderDeployment]
            : [deployment];
        if (activated && input.postActivationHeads) {
          const head =
            input.postActivationHeads[postActivationReads++] ?? input.postActivationHeads.at(-1);
          if (head instanceof Error) {
            throw head;
          }
          if (head === 'empty') {
            data = [];
          } else if (head === 'older') {
            data = [olderDeployment];
          } else if (head && head !== 'previous') {
            visibleVersionId = head === 'activated' ? NEXT_VERSION : 'version-competing';
            data.unshift({
              created_on: '2026-09-30T00:01:00.000Z',
              id: `deployment-${head}`,
              versions: [
                {
                  percentage: 100,
                  version_id: visibleVersionId,
                },
              ],
            });
          }
        }
        return {
          status: 0,
          stderr: '',
          stdout: '',
          data,
        };
      }
      if (args.type === 'triggers.deploy') {
        return { status: input.triggerFailure ? 1 : 0, stderr: '', stdout: '', data: '' };
      }
      if (args.type === 'versions.upload') {
        if (input.postActivationHeads) {
          return { status: 0, stderr: '', stdout: '', data: { versionId: NEXT_VERSION } };
        }
        if (input.mutateScriptAtUpload) {
          writeFileSync(main, 'export default { fetch() { return new Response("changed"); } };');
          const uploadConfig = JSON.parse(readFileSync(args.configPath!, 'utf8')) as {
            main: string;
          };
          uploadedScript = readFileSync(uploadConfig.main, 'utf8');
          const metadata = parseCloudflareVersionMessage(args.message);
          uploadedHash = metadata?.schema === 2 ? (metadata.contentHash ?? null) : null;
        }
        return { status: 1, stderr: 'upload reached', stdout: '', data: '' };
      }
      if (args.type === 'versions.deploy' && input.postActivationHeads) {
        activated = true;
        return { status: 0, stderr: '', stdout: '' };
      }
      if (args.type === 'worker.deploy' && input.postActivationHeads) {
        activated = true;
        return { status: 0, stderr: '', stdout: '', data: { versionId: NEXT_VERSION } };
      }
      throw new Error(`Unexpected command: ${args.type}`);
    };
    conditionalCreate.runner = runner;
    wait.mockClear();
    const operation = deployPlatformWorker(desiredConfig, input.secrets ?? null, {
      apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      ...(input.acquireUploadSlot ? { acquireUploadSlot: input.acquireUploadSlot } : {}),
      ...(input.directApi ? { readCloudflare } : {}),
      ...(input.onReadyForActivation ? { onReadyForActivation: input.onReadyForActivation } : {}),
      ...(input.reuseMatchingVersion === undefined
        ? {}
        : { reuseMatchingVersion: input.reuseMatchingVersion }),
      ...(input.waitForPriorWorker ? { waitForPriorWorker: input.waitForPriorWorker } : {}),
      inspectNewWorker: async () => 'owned',
      managedRoutes: [],
      onStaged: async () => {},
      onTrafficPublished,
      onUnsafeTraffic,
      preservedRoutes: [],
      previousConfig: config,
      previousPublicEndpoints: true,
      publishCustomDomains: async () => {},
      publishRoutes: async () => {},
      retainNewWorker,
      runner,
      workerExisted,
    });
    const outcome = await operation.then(
      (value) => ({ error: null, value }),
      (error: unknown) => ({ error, value: null }),
    );
    return {
      calls,
      onTrafficPublished,
      onUnsafeTraffic,
      postActivationReads,
      readCloudflare,
      retainNewWorker,
      uploadedScript,
      uploadedHash,
      expectedHash,
      ...outcome,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('waits for stale deployment history after activation without deploying again', async () => {
  const run = await attemptReuse({
    changeConfig: true,
    postActivationHeads: ['previous', 'activated'],
  });

  expect(run.error).toBeNull();
  expect(run.calls.filter((call) => call === 'versions.deploy')).toHaveLength(1);
  expect(run.postActivationReads).toBe(2);
  expect(run.onTrafficPublished).toHaveBeenCalledOnce();
});

it('stops checking activation as soon as a competing deployment appears', async () => {
  const run = await attemptReuse({
    changeConfig: true,
    postActivationHeads: ['previous', 'competing', 'activated'],
  });

  expect(String(run.error)).toContain('changed concurrently after activation');
  expect(run.calls.filter((call) => call === 'versions.deploy')).toHaveLength(1);
  expect(run.postActivationReads).toBe(2);
  expect(run.onTrafficPublished).not.toHaveBeenCalled();
});

it('waits through an empty deployment history after activation', async () => {
  const run = await attemptReuse({
    changeConfig: true,
    postActivationHeads: ['empty', 'activated'],
  });

  expect(run.error).toBeNull();
  expect(run.calls.filter((call) => call === 'versions.deploy')).toHaveLength(1);
  expect(run.postActivationReads).toBe(2);
  expect(run.onTrafficPublished).toHaveBeenCalledOnce();
});

it('waits through an older known deployment at the head after activation', async () => {
  const run = await attemptReuse({
    changeConfig: true,
    postActivationHeads: ['older', 'activated'],
  });

  expect(run.error).toBeNull();
  expect(run.calls.filter((call) => call === 'versions.deploy')).toHaveLength(1);
  expect(run.postActivationReads).toBe(2);
  expect(run.onTrafficPublished).toHaveBeenCalledOnce();
});

it('still refuses an unknown deployment after a stale empty history', async () => {
  const run = await attemptReuse({
    changeConfig: true,
    postActivationHeads: ['empty', 'competing', 'activated'],
  });

  expect(String(run.error)).toContain('changed concurrently after activation');
  expect(run.error).not.toBeInstanceOf(PlatformWorkerRecoveryIncompleteError);
  expect(run.postActivationReads).toBe(2);
  expect(run.onTrafficPublished).not.toHaveBeenCalled();
});

it.each([
  { head: 'empty' as const, reason: 'lists no deployments for it yet' },
  { head: 'older' as const, reason: 'still reports older deployment deployment-older' },
])('keeps the cutover unresolved when the history stays $head', async ({ head, reason }) => {
  const run = await attemptReuse({ changeConfig: true, postActivationHeads: [head] });

  expect(run.error).toBeInstanceOf(PlatformWorkerRecoveryIncompleteError);
  expect(String(run.error)).toContain(
    `could not confirm activation of void-test-api because Cloudflare ${reason}.`,
  );
  expect(run.calls.filter((call) => call === 'versions.deploy')).toHaveLength(1);
  expect(run.postActivationReads).toBe(4);
  expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 500, 1000]);
  expect(run.onTrafficPublished).not.toHaveBeenCalled();
});

it('waits through an empty deployment history after creating a new Worker', async () => {
  const run = await attemptReuse({
    changeConfig: true,
    postActivationHeads: ['empty', 'activated'],
    workerExisted: false,
  });

  expect(run.error).toBeNull();
  expect(run.calls.filter((call) => call === 'worker.deploy')).toHaveLength(1);
  expect(run.calls).not.toContain('versions.deploy');
  expect(run.postActivationReads).toBe(2);
  expect(run.onTrafficPublished).toHaveBeenCalledOnce();
});

it('still refuses an unknown deployment on a new Worker', async () => {
  const run = await attemptReuse({
    changeConfig: true,
    postActivationHeads: ['competing'],
    workerExisted: false,
  });

  expect(String(run.error)).toContain('changed concurrently after activation');
  expect(run.postActivationReads).toBe(1);
  expect(run.onTrafficPublished).not.toHaveBeenCalled();
});

it('keeps the cutover unresolved when activation does not become visible', async () => {
  const run = await attemptReuse({ changeConfig: true, postActivationHeads: ['previous'] });

  expect(run.error).toBeInstanceOf(PlatformWorkerRecoveryIncompleteError);
  expect(String(run.error)).toContain('could not confirm activation');
  expect(run.calls.filter((call) => call === 'versions.deploy')).toHaveLength(1);
  expect(run.postActivationReads).toBe(4);
  expect(run.onTrafficPublished).not.toHaveBeenCalled();
});

it('keeps the cutover unresolved when a stale deployment history cannot be reread', async () => {
  const readError = new Error('Deployment history unavailable');
  const run = await attemptReuse({
    changeConfig: true,
    postActivationHeads: ['previous', readError],
  });

  expect(run.calls.filter((call) => call === 'versions.deploy')).toHaveLength(1);
  expect(run.calls).not.toContain('triggers.deploy');
  expect(run.onTrafficPublished).not.toHaveBeenCalled();
  expect(run.error).toBeInstanceOf(PlatformWorkerRecoveryIncompleteError);
  expect(run.error).toHaveProperty('cause', readError);
});

it('reconciles traffic without uploading an identical active Worker version', async () => {
  const run = await attemptReuse({});
  expect(run.error).toBeNull();
  expect(run.value).toBeNull();
  expect(run.calls).not.toContain('versions.upload');
  expect(run.calls).toContain('triggers.deploy');
  expect(run.onTrafficPublished).toHaveBeenCalledOnce();
});

it.each([{ directApi: false }, { directApi: true }])(
  'uploads a fresh version for identical input when reuse is disabled: %j',
  async ({ directApi }) => {
    const run = await attemptReuse({ directApi, reuseMatchingVersion: false });
    expect(String(run.error)).toContain('upload reached');
    expect(run.calls).toContain('versions.upload');
    expect(run.calls).not.toContain('triggers.deploy');
    expect(run.onTrafficPublished).not.toHaveBeenCalled();
  },
);

it('uses direct Cloudflare reads for a verified matching version', async () => {
  const run = await attemptReuse({ directApi: true });
  expect(run.error).toBeNull();
  expect(run.calls).toEqual(['triggers.deploy']);
  expect(run.readCloudflare.mock.calls.map(([path]) => String(path).split('/').at(-1))).toEqual([
    'deployments',
    VERSION,
    'deployments',
    'void-test-api',
    'schedules',
    'workflows?page=1&per_page=100',
    'workflows?page=2&per_page=100',
    'deployments',
    'deployments',
    'deployments',
  ]);
});

it('waits for the preceding Worker before changing reused Worker traffic', async () => {
  let release!: () => void;
  let reachedBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    reachedBarrier = resolve;
  });
  const commands: Array<string> = [];
  const result = attemptReuse({
    directApi: true,
    onCommand: (command) => commands.push(command),
    waitForPriorWorker: async () => {
      reachedBarrier();
      await barrier;
    },
  });
  await waiting;
  expect(commands).toEqual([]);
  release();
  expect((await result).error).toBeNull();
  expect(commands).toContain('triggers.deploy');
});

it('waits for the upload batch before changing reused Worker traffic', async () => {
  let release!: () => void;
  let reachedBatch!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    reachedBatch = resolve;
  });
  const commands: Array<string> = [];
  const result = attemptReuse({
    directApi: true,
    onCommand: (command) => commands.push(command),
    onReadyForActivation: async () => {
      reachedBatch();
      await barrier;
    },
  });
  await waiting;
  expect(commands).toEqual([]);
  release();
  expect((await result).error).toBeNull();
  expect(commands).toContain('triggers.deploy');
});

it('uses direct reads while preparing a changed Worker upload', async () => {
  const run = await attemptReuse({ changeConfig: true, directApi: true });
  expect(String(run.error)).toContain('upload reached');
  expect(run.calls).toEqual(['versions.upload']);
  expect(run.readCloudflare).toHaveBeenCalled();
});

it('releases an upload slot when the upload fails', async () => {
  const events: Array<string> = [];
  const run = await attemptReuse({
    acquireUploadSlot: async () => {
      events.push('acquired');
      return (failure?: unknown) => {
        events.push(failure instanceof Error ? 'failed' : 'released');
      };
    },
    changeConfig: true,
    directApi: true,
    onCommand: (command) => events.push(command),
  });
  expect(String(run.error)).toContain('upload reached');
  expect(events).toEqual(['acquired', 'versions.upload', 'failed']);
});

it('falls back to cf reads when the direct API is unavailable', async () => {
  const run = await attemptReuse({
    changeConfig: true,
    directApi: true,
    directReadFailure: true,
  });
  expect(String(run.error)).toContain('upload reached');
  expect(run.calls).toContain('deployments.status');
  expect(run.calls).toContain('versions.view');
  expect(run.calls).toContain('versions.upload');
});

it('skips trigger publication only after live traffic matches the reused version', async () => {
  const run = await attemptReuse({ directApi: true, liveTriggers: true });
  expect(run.error).toBeNull();
  expect(run.calls).not.toContain('triggers.deploy');
  expect(run.onTrafficPublished).toHaveBeenCalledOnce();
});

it('closes the routing gate if deployment lineage changes after live trigger proof', async () => {
  const run = await attemptReuse({
    directApi: true,
    liveTriggers: true,
    directProofDeploymentDrift: true,
  });
  expect(String(run.error)).toContain('changed deployment lineage during trigger verification');
  expect(run.calls).not.toContain('triggers.deploy');
  expect(run.onUnsafeTraffic).toHaveBeenCalledOnce();
  expect(run.retainNewWorker).toHaveBeenCalledOnce();
});

it('refuses reuse when direct Cloudflare reads observe a deployment change', async () => {
  const run = await attemptReuse({ directApi: true, directDeploymentDrift: true });
  expect(String(run.error)).toContain('changed concurrently');
  expect(run.calls).not.toContain('versions.upload');
});

it('closes the routing gate when a direct read detects a deployment change after triggers', async () => {
  const run = await attemptReuse({ directApi: true, directLateDeploymentDrift: true });
  expect(String(run.error)).toContain('traffic reconciliation failed');
  expect(run.calls).not.toContain('versions.upload');
  expect(run.onUnsafeTraffic).toHaveBeenCalledOnce();
  expect(run.retainNewWorker).toHaveBeenCalledOnce();
});

it.each([
  { changeConfig: true },
  { changeScript: true },
  { secrets: { TOKEN: 'changed' } },
  { annotationHash: 'f'.repeat(64) },
  { missingAnnotationHash: true },
])('uploads when the active version does not prove identical input: %j', async (input) => {
  const run = await attemptReuse(input);
  expect(String(run.error)).toContain('upload reached');
  expect(run.calls).toContain('versions.upload');
});

it('uploads copied artifact bytes matching the version annotation when source files change', async () => {
  const run = await attemptReuse({ annotationHash: 'f'.repeat(64), mutateScriptAtUpload: true });
  expect(String(run.error)).toContain('upload reached');
  expect(run.uploadedScript).toContain('Response("one")');
  expect(run.uploadedHash).toBe(run.expectedHash);
});

it('fails closed when the active version changes during inspection', async () => {
  const run = await attemptReuse({ versionDrift: true });
  expect(String(run.error)).toContain('changed concurrently');
  expect(run.calls).not.toContain('versions.upload');
});

it.each([{ triggerFailure: true }, { lateVersionDrift: true }])(
  'closes the routing gate if reuse reconciliation becomes unsafe: %j',
  async (input) => {
    const run = await attemptReuse(input);
    expect(String(run.error)).toContain('traffic reconciliation failed');
    expect(run.calls).not.toContain('versions.upload');
    expect(run.onUnsafeTraffic).toHaveBeenCalledOnce();
    expect(run.retainNewWorker).toHaveBeenCalledOnce();
  },
);
