import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  activateCloudflareVersion,
  assertCloudflareDurableObjectLifecycleSupported,
  deployCloudflareVersionTriggers,
  encodeCloudflareVersionMessage,
  extractWorkersDevSubdomain,
  normalizeWorkersDevSubdomain,
  parseCloudflareVersionMessage,
  readCloudflareTriggerConfig,
  type CloudflareCommandResult,
  type CloudflareOperation,
  type CloudflareTriggerConfig,
} from '../../src/index.ts';
import { operationFixture } from '../operation-fixture.ts';
import { voidSecretDraftVersion } from '../secret-draft-fixture.ts';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const CONCURRENT = '33333333-3333-4333-8333-333333333333';

function triggersWith(overrides: Partial<CloudflareTriggerConfig> = {}): CloudflareTriggerConfig {
  return {
    workers_dev: true,
    preview_urls: true,
    routes: [],
    crons: [],
    queueConsumers: [],
    workflows: [],
    ...overrides,
  };
}

function customDomainTriggers(pattern: string): CloudflareTriggerConfig {
  return triggersWith({
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern, custom_domain: true }],
  });
}

function readConfigArg(args: Array<string>): Record<string, unknown> {
  return JSON.parse(readFileSync(args[args.indexOf('-c') + 1]!, 'utf8')) as Record<string, unknown>;
}

function sdkDraftActivation(source: Record<string, unknown> = voidSecretDraftVersion()) {
  const events: Array<string> = [];
  const operations: Array<CloudflareOperation> = [];
  const message = encodeCloudflareVersionMessage([], triggersWith());
  let traffic = [{ version_id: CURRENT, percentage: 100 }];
  let uploaded = false;
  let published = false;
  let triggers = false;
  let ordinary = false;
  let readSource = async () => source;
  const runWrangler = vi.fn(
    async (operation: CloudflareOperation): Promise<CloudflareCommandResult> => {
      operations.push(operation);
      if (operation.type === 'deployments.status') {
        return { ...ok(), data: { versions: traffic } };
      }
      if (operation.type === 'versions.list') {
        return {
          ...ok(),
          data: [
            {
              id: CURRENT,
              number: 2,
              annotations: ordinary
                ? { 'workers/message': message }
                : { 'workers/triggered_by': 'secret' },
            },
            ...(uploaded
              ? [{ id: NEXT, number: 3, annotations: { 'workers/message': message } }]
              : []),
          ],
        };
      }
      if (operation.type === 'versions.view') {
        if (operation.includeSource) {
          events.push('source');
          return { ...ok(), data: await readSource() };
        }
        return {
          ...ok(),
          data: {
            id: operation.versionId,
            resources: { bindings: [{ name: 'TOKEN', type: 'secret_text' }] },
          },
        };
      }
      if (operation.type === 'versions.upload') {
        events.push('upload');
        uploaded = true;
        return {
          ...ok(),
          data: {
            versionId: NEXT,
            previewUrl: `https://${NEXT.slice(0, 8)}-app.example.workers.dev`,
          },
        };
      }
      if (operation.type === 'worker.deploy') {
        events.push('publish');
        uploaded = true;
        published = true;
        traffic = [{ version_id: NEXT, percentage: 100 }];
        return {
          ...ok(),
          data: { versionId: NEXT, workersDevUrl: 'https://app.example.workers.dev' },
        };
      }
      if (operation.type === 'versions.deploy') {
        events.push('activate');
        traffic = operation.versions.map(({ versionId, percentage }) => ({
          version_id: versionId,
          percentage,
        }));
        return ok();
      }
      if (operation.type.startsWith('triggers.')) {
        events.push('triggers');
        triggers = true;
        return ok();
      }
      throw new Error(`Unexpected SDK draft operation: ${operation.type}`);
    },
  );
  const pinActiveSecrets = vi.fn(async (id: string, bindings: unknown) => {
    expect(id).toBe(CURRENT);
    expect(bindings).toEqual([{ name: 'TOKEN', type: 'secret_text' }]);
    events.push('pin');
    return true;
  });
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (published) {
      expect(triggers).toBe(true);
      expect(String(url)).toBe('https://app.example.workers.dev/__void/ready');
    }
    events.push('ready');
    return Response.json({ ready: true, versionId: NEXT });
  });
  return {
    events,
    operations,
    runWrangler,
    pinActiveSecrets,
    fetcher,
    changeOwner: (versions = [{ version_id: CONCURRENT, percentage: 100 }]) => {
      traffic = versions;
    },
    sourceRead: (read: () => Promise<Record<string, unknown>>) => {
      readSource = read;
    },
    ordinary: () => {
      ordinary = true;
    },
    options: {
      runWrangler,
      pinActiveSecrets,
      fetch: fetcher,
      workerName: 'app',
      message,
      verifyUploader: () => true,
      verifyInheritedSecrets: true,
      requireVersionMetadata: true,
      readinessAttempts: 1,
    },
  };
}

// The bundled uploader rejects locally without an API error code; keep its actual diagnostic.
const LOCAL_DURABLE_MIGRATION_ERROR =
  'This Worker has a pending Durable Object migration, which cannot be applied by `wrangler versions upload`. Durable Object migrations must be applied with `wrangler deploy`. Run `wrangler deploy` to apply the migration, then retry `wrangler versions upload`.';

function secretOnlyDraftVersion() {
  return {
    id: CURRENT,
    annotations: { 'workers/triggered_by': 'secret' },
    resources: {
      bindings: [{ name: 'API_TOKEN', type: 'secret_text' }],
      script: {
        etag: 'draft',
        handlers: ['fetch'],
        last_deployed_from: 'wrangler',
      },
      script_runtime: { usage_model: 'standard', limits: {} },
    },
  };
}

function ok(stdout = ''): CloudflareCommandResult {
  return { stdout, stderr: '', status: 0 };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function runner(overrides?: {
  status?: CloudflareCommandResult;
  upload?: CloudflareCommandResult;
  bootstrap?: CloudflareCommandResult;
  activate?: CloudflareCommandResult;
  triggers?: CloudflareCommandResult;
  triggerRollback?: CloudflareCommandResult;
  rollback?: CloudflareCommandResult;
  versions?: CloudflareCommandResult;
}) {
  let deployCalls = 0;
  let triggerCalls = 0;
  let statusCalls = 0;
  let activeVersionId: string | null = CURRENT;
  let deploymentVersions: Array<{ version_id: string; percentage: number }> = [
    { version_id: CURRENT, percentage: 100 },
  ];
  let uploaded = false;
  return operationFixture((args: Array<string>) => {
    if (args[0] === 'deployments') {
      statusCalls++;
      if (statusCalls === 1 && overrides?.status) {
        if (overrides.status.status !== 0) {
          activeVersionId = null;
          deploymentVersions = [];
        }
        return overrides.status;
      }
      return ok(JSON.stringify({ versions: deploymentVersions }));
    }
    if (args[0] === 'versions' && args[1] === 'upload') {
      uploaded = true;
      return (
        overrides?.upload ??
        ok(
          `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://ready.example.workers.dev`,
        )
      );
    }
    if (args[0] === 'versions' && args[1] === 'deploy') {
      deployCalls++;
      const result =
        deployCalls === 1 ? (overrides?.activate ?? ok()) : (overrides?.rollback ?? ok());
      if (result.status === 0) {
        deploymentVersions = args.flatMap((argument) => {
          const matched = argument.match(/^([^@]+)@(\d+(?:\.\d+)?)$/);
          return matched ? [{ version_id: matched[1]!, percentage: Number(matched[2]) }] : [];
        });
        activeVersionId =
          deploymentVersions.find((version) => version.percentage === 100)?.version_id ?? null;
      }
      return result;
    }
    if (args[0] === 'versions' && args[1] === 'list') {
      return (
        overrides?.versions ??
        ok(
          JSON.stringify([
            {
              id: CURRENT,
              number: 1,
              annotations: {
                'workers/message': encodeCloudflareVersionMessage(
                  [],
                  triggersWith({ crons: ['0 * * * *'] }),
                ),
              },
            },
            ...(uploaded ? [{ id: NEXT, number: 2, annotations: {} }] : []),
          ]),
        )
      );
    }
    if (args[0] === 'deploy') {
      const result = overrides?.bootstrap ?? ok();
      if (result.status === 0) {
        activeVersionId =
          `${result.stdout}\n${result.stderr}`.match(
            /(?:Worker|Current) Version ID:\s*([0-9a-f-]+)/i,
          )?.[1] ?? activeVersionId;
        deploymentVersions = activeVersionId
          ? [{ version_id: activeVersionId, percentage: 100 }]
          : [];
      }
      return result;
    }
    if (args[0] === 'triggers') {
      triggerCalls++;
      return triggerCalls === 1
        ? (overrides?.triggers ?? ok())
        : (overrides?.triggerRollback ?? ok());
    }
    if (args[0] === 'queues') {
      return ok();
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
}

describe('Cloudflare version activation', () => {
  it('pins ordinary revision secrets to the inspected active UUID before upload and readiness', async () => {
    const fixture = sdkDraftActivation();
    fixture.ordinary();
    const result = await activateCloudflareVersion(fixture.options);
    expect(result).toMatchObject({ ok: true, versionId: NEXT, previousVersionId: CURRENT });
    expect(fixture.pinActiveSecrets).toHaveBeenCalledExactlyOnceWith(CURRENT, [
      { name: 'TOKEN', type: 'secret_text' },
    ]);
    expect(fixture.events.indexOf('pin')).toBeLessThan(fixture.events.indexOf('upload'));
    expect(fixture.events.indexOf('upload')).toBeLessThan(fixture.events.indexOf('ready'));
    expect(fixture.events.indexOf('ready')).toBeLessThan(fixture.events.indexOf('activate'));
    expect(fixture.operations.filter((op) => op.type === 'versions.upload')).toHaveLength(1);
    expect(
      fixture.operations.some(
        (op) => op.type === 'worker.deploy' || (op.type === 'versions.view' && op.includeSource),
      ),
    ).toBe(false);
  });

  it.each(['refused', 'thrown', 'unreadable', 'wrong-version'] as const)(
    'does not upload an ordinary revision when active-secret pinning is %s',
    async (kind) => {
      const fixture = sdkDraftActivation();
      fixture.ordinary();
      if (kind === 'refused') {
        fixture.pinActiveSecrets.mockResolvedValue(false);
      }
      if (kind === 'thrown') {
        fixture.pinActiveSecrets.mockRejectedValue(new Error('private synthetic pin detail'));
      }
      const original = fixture.runWrangler.getMockImplementation()!;
      if (kind === 'unreadable' || kind === 'wrong-version') {
        fixture.runWrangler.mockImplementation(async (op) =>
          op.type === 'versions.view'
            ? kind === 'unreadable'
              ? { status: 1, stdout: '', stderr: 'private synthetic inspection detail' }
              : {
                  ...ok(),
                  data: { id: CONCURRENT, resources: { bindings: [] } },
                }
            : original(op),
        );
      }
      const result = await activateCloudflareVersion(fixture.options);
      expect(result).toMatchObject({
        ok: false,
        reason:
          kind === 'refused' ? 'inheritance-source-changed' : 'inheritance-source-unavailable',
      });
      expect(JSON.stringify(result)).not.toContain('private synthetic');
      expect(fixture.events).not.toContain('upload');
      expect(fixture.events).not.toContain('publish');
      expect(fixture.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ name: '', type: 'secret_text' }],
    [{ name: ' TOKEN ', type: 'secret_text' }],
    [
      { name: 'TOKEN', type: 'secret_text' },
      { name: 'TOKEN', type: 'secret_key' },
    ],
  ])('rejects ambiguous active secret names before ordinary upload: %j', async (...bindings) => {
    const fixture = sdkDraftActivation();
    fixture.ordinary();
    const original = fixture.runWrangler.getMockImplementation()!;
    fixture.runWrangler.mockImplementation(async (op) =>
      op.type === 'versions.view'
        ? { ...ok(), data: { id: CURRENT, resources: { bindings } } }
        : original(op),
    );
    expect(await activateCloudflareVersion(fixture.options)).toMatchObject({
      ok: false,
      reason: 'inheritance-source-changed',
    });
    expect(fixture.pinActiveSecrets).not.toHaveBeenCalled();
    expect(fixture.events).not.toContain('upload');
  });

  it.each(['replacement', 'companion'] as const)(
    'refuses ordinary upload when a %s deployment appears during secret pinning',
    async (kind) => {
      const fixture = sdkDraftActivation();
      fixture.ordinary();
      const entered = deferred<void>();
      const release = deferred<boolean>();
      fixture.pinActiveSecrets.mockImplementation(async () => {
        entered.resolve();
        return release.promise;
      });
      const activation = activateCloudflareVersion(fixture.options);
      await entered.promise;
      fixture.changeOwner(
        kind === 'replacement'
          ? [{ version_id: CONCURRENT, percentage: 100 }]
          : [
              { version_id: CURRENT, percentage: 100 },
              { version_id: CONCURRENT, percentage: 0 },
            ],
      );
      release.resolve(true);
      expect(await activation).toMatchObject({
        ok: false,
        reason: 'deployment-changed',
        rollback: 'not-needed',
      });
      expect(fixture.events).not.toContain('upload');
      expect(fixture.events).not.toContain('publish');
      expect(fixture.fetcher).not.toHaveBeenCalled();
    },
  );

  it('retains ordinary explicit replacement without requiring remote-only secret pinning', async () => {
    const fixture = sdkDraftActivation();
    fixture.ordinary();
    fixture.pinActiveSecrets.mockResolvedValue(false);
    const original = fixture.runWrangler.getMockImplementation()!;
    fixture.runWrangler.mockImplementation(async (op) => {
      if (op.type === 'versions.upload') {
        expect(JSON.parse(readFileSync(op.secretsFilePath!, 'utf8'))).toEqual({
          TOKEN: 'synthetic replacement',
          NEW_SECRET: 'synthetic new secret',
        });
      }
      return original(op);
    });
    expect(
      await activateCloudflareVersion({
        ...fixture.options,
        candidateSecrets: { TOKEN: 'synthetic replacement', NEW_SECRET: 'synthetic new secret' },
      }),
    ).toMatchObject({ ok: true, versionId: NEXT });
    expect(fixture.pinActiveSecrets).not.toHaveBeenCalled();
    expect(fixture.operations.filter((op) => op.type === 'versions.upload')).toHaveLength(1);
  });

  it('keeps an ordinary app without remote secrets on the normal uploader', async () => {
    const fixture = sdkDraftActivation();
    fixture.ordinary();
    fixture.pinActiveSecrets.mockResolvedValue(false);
    const original = fixture.runWrangler.getMockImplementation()!;
    fixture.runWrangler.mockImplementation(async (op) =>
      op.type === 'versions.view'
        ? { ...ok(), data: { id: CURRENT, resources: { bindings: [] } } }
        : original(op),
    );
    expect(await activateCloudflareVersion(fixture.options)).toMatchObject({
      ok: true,
      versionId: NEXT,
    });
    expect(fixture.pinActiveSecrets).not.toHaveBeenCalled();
    expect(fixture.operations.filter((op) => op.type === 'versions.upload')).toHaveLength(1);
    expect(
      fixture.operations.some(
        (op) => op.type === 'worker.deploy' || (op.type === 'versions.view' && op.includeSource),
      ),
    ).toBe(false);
  });

  it('publishes an exact private SDK draft once, proving secrets and callbacks before readiness', async () => {
    const fixture = sdkDraftActivation({
      ...voidSecretDraftVersion(),
      number: undefined,
      compatibility_date: undefined,
      usage_model: undefined,
    });
    const validateUploadedVersion = vi.fn(async (id: string) => {
      expect(id).toBe(NEXT);
      fixture.events.push('validate');
    });
    const recordVerifiedCandidate = vi.fn(async (id: string, parent: string | null) => {
      expect([id, parent]).toEqual([NEXT, CURRENT]);
      fixture.events.push('checkpoint');
    });
    const result = await activateCloudflareVersion({
      ...fixture.options,
      validateUploadedVersion,
      recordVerifiedCandidate,
    });
    expect(result).toMatchObject({ ok: true, versionId: NEXT, previousVersionId: CURRENT });
    expect(fixture.events.slice(0, 5)).toEqual([
      'source',
      'pin',
      'publish',
      'validate',
      'checkpoint',
    ]);
    expect(fixture.operations.filter((op) => op.type === 'worker.deploy')).toHaveLength(1);
    expect(
      fixture.operations.some(
        (op) => op.type === 'versions.upload' || op.type === 'versions.deploy',
      ),
    ).toBe(false);
    expect(fixture.fetcher).toHaveBeenCalledOnce();
  });

  it('does not overwrite a deployment that changed during immutable draft source inspection', async () => {
    const fixture = sdkDraftActivation();
    const entered = deferred<void>(),
      release = deferred<Record<string, unknown>>();
    fixture.sourceRead(() => {
      entered.resolve();
      return release.promise;
    });
    const activation = activateCloudflareVersion(fixture.options);
    await entered.promise;
    fixture.changeOwner();
    release.resolve(voidSecretDraftVersion());
    expect(await activation).toMatchObject({
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: CONCURRENT,
    });
    expect(
      fixture.operations.some((op) =>
        ['worker.deploy', 'versions.upload', 'versions.deploy', 'triggers.deploy'].includes(
          op.type,
        ),
      ),
    ).toBe(false);
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it('refuses extra zero-percent traffic before publishing a draft', async () => {
    const fixture = sdkDraftActivation();
    fixture.sourceRead(async () => {
      fixture.changeOwner([
        { version_id: CURRENT, percentage: 100 },
        { version_id: CONCURRENT, percentage: 0 },
      ]);
      return voidSecretDraftVersion();
    });
    expect(await activateCloudflareVersion(fixture.options)).toMatchObject({
      ok: false,
      reason: 'deployment-changed',
    });
    expect(fixture.events).not.toContain('publish');
  });

  it.each(['missing', 'refused', 'unreadable', 'failed'] as const)(
    'refuses %s required secret pinning before publishing an SDK draft',
    async (kind) => {
      const fixture = sdkDraftActivation();
      if (kind === 'refused') {
        fixture.pinActiveSecrets.mockResolvedValue(false);
      }
      if (kind === 'failed') {
        fixture.pinActiveSecrets.mockRejectedValue(new Error('private synthetic pin detail'));
      }
      const original = fixture.runWrangler.getMockImplementation()!;
      if (kind === 'unreadable') {
        fixture.runWrangler.mockImplementation(async (op) =>
          op.type === 'versions.view' && !op.includeSource
            ? { status: 1, stdout: '', stderr: 'synthetic failure' }
            : original(op),
        );
      }
      const result = await activateCloudflareVersion({
        ...fixture.options,
        pinActiveSecrets: kind === 'missing' ? undefined : fixture.pinActiveSecrets,
      });
      expect(result).toMatchObject({
        ok: false,
        reason:
          kind === 'refused' ? 'inheritance-source-changed' : 'inheritance-source-unavailable',
      });
      expect(fixture.events).not.toContain('publish');
      expect(fixture.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { bindings: [] },
    { bindings: [{ name: 'OTHER', type: 'secret_text' }] },
    { bindings: [{ name: 'TOKEN', type: 'secret_key' }] },
    {
      bindings: [
        { name: 'TOKEN', type: 'secret_text' },
        { name: 'TOKEN', type: 'secret_text' },
      ],
    },
  ])('refuses active secrets that contradict the immutable SDK draft: %j', async ({ bindings }) => {
    const fixture = sdkDraftActivation();
    const original = fixture.runWrangler.getMockImplementation()!;
    fixture.runWrangler.mockImplementation(async (op) =>
      op.type === 'versions.view' && !op.includeSource
        ? { ...ok(), data: { id: CURRENT, resources: { bindings } } }
        : original(op),
    );
    expect(await activateCloudflareVersion(fixture.options)).toMatchObject({
      ok: false,
      reason: 'inheritance-source-changed',
    });
    expect(fixture.pinActiveSecrets).not.toHaveBeenCalled();
    expect(fixture.events).not.toContain('publish');
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it('honors a refused active-secret pin for an atomic existing app', async () => {
    const fixture = sdkDraftActivation();
    fixture.ordinary();
    fixture.pinActiveSecrets.mockResolvedValue(false);
    expect(await activateCloudflareVersion({ ...fixture.options, atomic: true })).toMatchObject({
      ok: false,
      reason: 'inheritance-source-changed',
    });
    expect(fixture.events).not.toContain('publish');
  });

  it.each(['validation', 'checkpoint'] as const)(
    'reports a published UUID and stops triggers/readiness after %s fails',
    async (stage) => {
      const fixture = sdkDraftActivation();
      const validateUploadedVersion = vi.fn(async () => {
        if (stage === 'validation') {
          throw new Error('private synthetic detail');
        }
      });
      const recordVerifiedCandidate = vi.fn(async () => {
        throw new Error('private synthetic detail');
      });
      const result = await activateCloudflareVersion({
        ...fixture.options,
        validateUploadedVersion,
        recordVerifiedCandidate,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'bootstrap-failed',
        versionId: NEXT,
        rollback: 'unavailable',
      });
      expect(result.ok ? '' : result.diagnostic).toContain(NEXT);
      expect(result.ok ? '' : result.diagnostic).not.toContain('private synthetic detail');
      expect(fixture.events).toContain('publish');
      expect(fixture.events).not.toContain('triggers');
      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect(recordVerifiedCandidate).toHaveBeenCalledTimes(stage === 'validation' ? 0 : 1);
    },
  );

  it('does not record a checkpoint or publish triggers after validation observes a newer owner', async () => {
    const fixture = sdkDraftActivation();
    const recordVerifiedCandidate = vi.fn();
    const result = await activateCloudflareVersion({
      ...fixture.options,
      validateUploadedVersion: async () => {
        fixture.changeOwner();
      },
      recordVerifiedCandidate,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: CONCURRENT,
    });
    expect(recordVerifiedCandidate).not.toHaveBeenCalled();
    expect(fixture.events).not.toContain('triggers');
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it('retains preview-first activation for a secret-triggered real app', async () => {
    const fixture = sdkDraftActivation({
      ...voidSecretDraftVersion(),
      modules: [
        {
          ...voidSecretDraftVersion().modules[0],
          content_base64: Buffer.from(
            'export default { fetch() { return new Response("real app"); } };',
          ).toString('base64'),
        },
      ],
    });
    expect(await activateCloudflareVersion(fixture.options)).toMatchObject({
      ok: true,
      versionId: NEXT,
    });
    expect(fixture.events).not.toContain('publish');
    expect(fixture.events).toContain('upload');
  });

  it('does not inspect source or bootstrap an ordinary version', async () => {
    const fixture = sdkDraftActivation();
    fixture.ordinary();
    expect(await activateCloudflareVersion(fixture.options)).toMatchObject({
      ok: true,
      versionId: NEXT,
    });
    expect(fixture.events).not.toContain('source');
    expect(fixture.events).not.toContain('publish');
  });

  it('never uses the draft bootstrap to bypass an explicit preview requirement', async () => {
    const fixture = sdkDraftActivation();
    expect(
      await activateCloudflareVersion({ ...fixture.options, requirePreviewForReadiness: true }),
    ).toMatchObject({ ok: true });
    expect(fixture.events).not.toContain('publish');
    expect(fixture.events).toContain('upload');
  });

  it('publishes explicitly atomic Durable Object deployments without a candidate stage', async () => {
    const runWrangler = runner({
      bootstrap: ok(`Worker Version ID: ${NEXT}\nhttps://my-worker.example.workers.dev`),
    });
    const result = await activateCloudflareVersion({
      runWrangler,
      workerName: 'my-worker',
      verifyUploader: () => true,
      verifyInheritedSecrets: true,
      atomic: true,
      workersDevSubdomain: 'example',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => Response.json({ ready: true }),
    });
    expect(result).toMatchObject({
      ok: true,
      versionId: NEXT,
      previousVersionId: CURRENT,
      trafficConfig: { workers_dev: true },
    });
    expect(runWrangler.mock.calls.filter(([args]) => args[0] === 'deploy')).toHaveLength(1);
    expect(
      runWrangler.mock.calls.some(([args]) => args[0] === 'versions' && args[1] === 'upload'),
    ).toBe(false);
    expect(
      runWrangler.mock.calls.some(([args]) => args[0] === 'versions' && args[1] === 'deploy'),
    ).toBe(false);
  });
  it('pins active secrets for atomic publication when the active version is the latest', async () => {
    const base = runner({
      bootstrap: ok(`Worker Version ID: ${NEXT}\nhttps://my-worker.example.workers.dev`),
    });
    const runWrangler = operationFixture((args: Array<string>) =>
      args[0] === 'versions' && args[1] === 'view'
        ? ok(
            JSON.stringify({
              id: CURRENT,
              resources: { bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }] },
            }),
          )
        : base(args),
    );
    const pinActiveSecrets = vi.fn().mockResolvedValue(true);
    const result = await activateCloudflareVersion({
      runWrangler,
      workerName: 'my-worker',
      verifyUploader: () => true,
      verifyInheritedSecrets: true,
      pinActiveSecrets,
      atomic: true,
      workersDevSubdomain: 'example',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => Response.json({ ready: true }),
    });
    expect(result).toMatchObject({ ok: true, versionId: NEXT });
    expect(pinActiveSecrets).toHaveBeenCalledWith(CURRENT, [
      { name: 'AUTH_SECRET', type: 'secret_text' },
    ]);
  });
  it('returns the Cloudflare error when zero-percent staging fails', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}`),
      activate: {
        status: 1,
        stdout: '',
        stderr: `[ERROR] Invalid deployment: version depends on Durable Object migration fate-live-v1, but the current deployment is using live-v1. [code: 10210]`,
      },
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'example',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-staging-failed',
      cloudflareErrorCode: 10210,
      diagnostic: expect.stringContaining('Durable Object migration fate-live-v1'),
    });
  });
  it('shares the initial version snapshot while rechecking inheritance after upload', async () => {
    const runWrangler = runner();
    const result = await activateCloudflareVersion({
      runWrangler,
      workerName: 'my-worker',
      verifyUploader: () => true,
      verifyInheritedSecrets: true,
      message: encodeCloudflareVersionMessage([], triggersWith()),
      fetch: async () => Response.json({ ready: true }),
    });
    expect(result).toMatchObject({ ok: true, versionId: NEXT });
    const commands = runWrangler.mock.calls.map(([args]) => args.slice(0, 2).join(' '));
    expect(commands.filter((command) => command === 'versions list')).toHaveLength(2);
    expect(commands.indexOf('versions list')).toBeLessThan(commands.indexOf('versions upload'));
    expect(commands.lastIndexOf('versions list')).toBeGreaterThan(
      commands.indexOf('versions upload'),
    );
    expect(commands.filter((command) => command === 'deployments status')).toHaveLength(4);
  });

  it('links an existing version without publishing routes or Worker settings', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-link-version-'));
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'my-worker',
        account_id: 'account',
        observability: { enabled: false },
        logpush: false,
      }),
    );
    try {
      const base = runner();
      const validateUploadedVersion = vi.fn().mockResolvedValue(undefined);
      const runWrangler = operationFixture((args: Array<string>) => {
        if (args[0] === 'versions' && args[1] === 'deploy') {
          expect(readConfigArg(args)).toEqual({ account_id: 'account', name: 'my-worker' });
        }
        return base(args);
      });
      const result = await activateCloudflareVersion({
        runWrangler,
        configPath,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        validateUploadedVersion,
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      });
      expect(result).toMatchObject({ ok: true, previousVersionId: CURRENT, versionId: NEXT });
      expect(validateUploadedVersion).toHaveBeenCalledWith(NEXT);
      expect(
        runWrangler.mock.calls.some(([args]) =>
          ['triggers', 'deploy', 'secret'].includes(args[0]!),
        ),
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not activate a candidate with changed bindings or upload over a changed baseline', async () => {
    const runWrangler = runner();
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
        validateUploadedVersion: async () => {
          throw new Error('bindings changed');
        },
      }),
    ).rejects.toThrow('bindings changed');
    expect(
      runWrangler.mock.calls.some(([args]) => args[0] === 'versions' && args[1] === 'deploy'),
    ).toBe(false);
    runWrangler.mockClear();
    expect(
      await activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CONCURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).toMatchObject({ ok: false, reason: 'deployment-changed' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('does not inherit secrets from an unpublished Worker version', async () => {
    const unpublished = '44444444-4444-4444-8444-444444444444';
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          { id: CURRENT, number: 1 },
          { id: unpublished, number: 2 },
        ]),
      ),
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'inheritance-source-changed',
      activeVersionId: unpublished,
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('retries across its own recorded unpublished version without requiring secret values', async () => {
    const draft = '44444444-4444-4444-8444-444444444444';
    const base = runner();
    let uploaded = false;
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(
          JSON.stringify([
            { id: CURRENT, number: 1 },
            { id: draft, number: 2 },
            ...(uploaded ? [{ id: NEXT, number: 3 }] : []),
          ]),
        );
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        uploaded = true;
      }
      if (args[0] === 'versions' && args[1] === 'view') {
        throw new Error('Trusted chain should not need plaintext secret replacement');
      }
      return base(args);
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        verifyInheritedSecrets: true,
        trustedInheritanceVersionIds: [draft],
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, versionId: NEXT });
  });

  it('recovers a receipt whose last candidate already owns production', async () => {
    const runWrangler = runner();
    const recordVerifiedCandidate = vi.fn();
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        verifyInheritedSecrets: true,
        trustedInheritanceVersionIds: [CONCURRENT, CURRENT],
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
        recordVerifiedCandidate,
      }),
    ).resolves.toMatchObject({ ok: true, versionId: NEXT, previousVersionId: CURRENT });
    expect(recordVerifiedCandidate).toHaveBeenCalledWith(NEXT, CURRENT);
  });

  it('still rejects a foreign upload after the recorded candidate became active', async () => {
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          { id: CURRENT, number: 1 },
          { id: CONCURRENT, number: 2 },
        ]),
      ),
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        verifyInheritedSecrets: true,
        trustedInheritanceVersionIds: [CURRENT],
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'inheritance-source-changed' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('does not inherit any remote secret from a failed candidate newer than production', async () => {
    const failed = '44444444-4444-4444-8444-444444444444';
    const directory = mkdtempSync(join(tmpdir(), 'void-active-secret-inheritance-'));
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ name: 'my-worker' }));
    try {
      const base = runner({
        versions: ok(
          JSON.stringify([
            { id: CURRENT, number: 1 },
            { id: failed, number: 2 },
          ]),
        ),
      });
      const runWrangler = operationFixture((args: Array<string>) => {
        if (args[0] === 'versions' && args[1] === 'view') {
          const versionId = args[2]!;
          return ok(
            JSON.stringify({
              id: versionId,
              resources: {
                bindings: versionId === failed ? [{ name: 'RAW_SECRET', type: 'secret_text' }] : [],
              },
            }),
          );
        }
        return base(args);
      });
      await expect(
        activateCloudflareVersion({
          runWrangler,
          configPath,
          workerName: 'my-worker',
          verifyUploader: () => true,
          verifyInheritedSecrets: true,
          message: encodeCloudflareVersionMessage([]),
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'inheritance-source-changed',
        activeVersionId: failed,
      });
      expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not treat a newer foreign draft as a first-secret placeholder', async () => {
    const foreign = '44444444-4444-4444-8444-444444444444';
    const base = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      versions: ok(JSON.stringify([{ id: foreign, number: 1 }])),
    });
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'view') {
        return ok(
          JSON.stringify({
            id: foreign,
            resources: { bindings: [{ name: 'FOREIGN_SECRET', type: 'secret_text' }] },
          }),
        );
      }
      return base(args);
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'first-with-secret',
        verifyUploader: () => true,
        verifyInheritedSecrets: true,
        allowFirstDeploymentBootstrap: true,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'inheritance-source-changed',
      activeVersionId: foreign,
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('can replace every text secret explicitly when a failed candidate is latest', async () => {
    const failed = '44444444-4444-4444-8444-444444444444';
    const base = runner();
    let uploaded = false;
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(
          JSON.stringify([
            { id: CURRENT, number: 1 },
            { id: failed, number: 2 },
            ...(uploaded ? [{ id: NEXT, number: 3 }] : []),
          ]),
        );
      }
      if (args[0] === 'versions' && args[1] === 'view') {
        return ok(
          JSON.stringify({
            id: args[2],
            resources: { bindings: [{ name: 'API_TOKEN', type: 'secret_text' }] },
          }),
        );
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        uploaded = true;
      }
      return base(args);
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        verifyInheritedSecrets: true,
        candidateSecrets: { API_TOKEN: 'explicit-value' },
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, versionId: NEXT });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(true);
  });

  it('pins opaque secrets to the active version when an abandoned upload is latest', async () => {
    const abandoned = '44444444-4444-4444-8444-444444444444';
    const base = runner();
    let uploaded = false;
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(
          JSON.stringify([
            { id: CURRENT, number: 1 },
            { id: abandoned, number: 2 },
            ...(uploaded ? [{ id: NEXT, number: 3 }] : []),
          ]),
        );
      }
      if (args[0] === 'versions' && args[1] === 'view') {
        return ok(
          JSON.stringify({
            id: args[2],
            resources: { bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }] },
          }),
        );
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        uploaded = true;
      }
      return base(args);
    });
    const pinActiveSecrets = vi.fn().mockResolvedValue(true);
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        verifyInheritedSecrets: true,
        expectedPreviousVersionId: CURRENT,
        pinActiveSecrets,
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, versionId: NEXT });
    expect(pinActiveSecrets).toHaveBeenCalledWith(CURRENT, [
      { name: 'AUTH_SECRET', type: 'secret_text' },
    ]);
    expect(uploaded).toBe(true);
  });

  it('pins the active secrets when a saved receipt no longer covers the latest upload', async () => {
    const abandoned = '44444444-4444-4444-8444-444444444444';
    const base = runner({
      versions: ok(
        JSON.stringify([
          { id: CURRENT, number: 1 },
          { id: CONCURRENT, number: 2 },
          { id: abandoned, number: 3 },
        ]),
      ),
    });
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'view') {
        return ok(
          JSON.stringify({
            id: args[2],
            resources: { bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }] },
          }),
        );
      }
      return base(args);
    });
    const pinActiveSecrets = vi.fn().mockResolvedValue(false);
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        verifyInheritedSecrets: true,
        expectedPreviousVersionId: CURRENT,
        trustedInheritanceVersionIds: [CONCURRENT],
        pinActiveSecrets,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'inheritance-source-changed' });
    expect(pinActiveSecrets).toHaveBeenCalledWith(CURRENT, [
      { name: 'AUTH_SECRET', type: 'secret_text' },
    ]);
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('does not trust an unpublished version with a copied Void annotation', async () => {
    const unpublished = '44444444-4444-4444-8444-444444444444';
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          { id: CURRENT, number: 1 },
          {
            id: unpublished,
            number: 2,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([]) },
          },
        ]),
      ),
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'inheritance-source-changed',
      activeVersionId: unpublished,
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('does not activate when another version is uploaded during secret inheritance', async () => {
    const concurrent = '44444444-4444-4444-8444-444444444444';
    let listed = 0;
    const base = runner();
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        listed++;
        return ok(
          JSON.stringify(
            listed === 1
              ? [{ id: CURRENT, number: 1 }]
              : [
                  { id: CURRENT, number: 1 },
                  { id: concurrent, number: 2 },
                  { id: NEXT, number: 3 },
                ],
          ),
        );
      }
      return base(args);
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'inheritance-source-changed' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('detects an intervening version even when it is deleted before the second list', async () => {
    let listed = 0;
    const base = runner();
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        listed++;
        return ok(
          JSON.stringify(
            listed === 1
              ? [{ id: CURRENT, number: 1 }]
              : [
                  { id: CURRENT, number: 1 },
                  { id: NEXT, number: 3 },
                ],
          ),
        );
      }
      return base(args);
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'inheritance-source-changed' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('can retry through a consecutive inactive version with a local verification receipt', async () => {
    let listed = 0;
    const failedCandidate = CONCURRENT;
    const base = runner();
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        listed++;
        return ok(
          JSON.stringify(
            listed === 1
              ? [
                  { id: CURRENT, number: 1 },
                  { id: failedCandidate, number: 2 },
                ]
              : [
                  { id: CURRENT, number: 1 },
                  { id: failedCandidate, number: 2 },
                  { id: NEXT, number: 3 },
                ],
          ),
        );
      }
      return base(args);
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        preserveTriggers: true,
        expectedPreviousVersionId: CURRENT,
        trustedInheritanceVersionIds: [failedCandidate],
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, versionId: NEXT });
  });

  it('snapshots and restores effective workers.dev and preview URL defaults', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-defaults-'));
    const configPath = join(directory, 'wrangler.json');
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          name: 'app',
          account_id: 'account',
          assets: { directory: '/already-removed/client' },
          main: '/already-removed/worker.js',
        }),
      );
      const triggerConfig = readCloudflareTriggerConfig(configPath);
      expect(triggerConfig.workers_dev).toBe(true);
      expect(triggerConfig.preview_urls).toBe(true);

      writeFileSync(
        configPath,
        JSON.stringify({
          name: 'app',
          account_id: 'account',
          assets: { directory: '/already-removed/client' },
          main: '/already-removed/worker.js',
          workers_dev: false,
          preview_urls: false,
        }),
      );
      let applied: Record<string, unknown> | undefined;
      await deployCloudflareVersionTriggers({
        runWrangler: operationFixture(async (args) => {
          applied = readConfigArg(args);
          return ok();
        }),
        workerName: 'app',
        configPath,
        triggerConfig,
      });
      expect(applied).not.toHaveProperty('workers_dev');
      expect(applied).not.toHaveProperty('preview_urls');
      expect(applied).not.toHaveProperty('routes');
      expect(applied).toMatchObject({ name: 'app', account_id: 'account' });
      expect(applied).not.toHaveProperty('assets');
      expect(applied).not.toHaveProperty('main');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not infer whole-trigger preservation for an ordinary empty config', () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-empty-source-'));
    const generatedPath = join(directory, 'generated.json');
    const sourcePath = join(directory, 'wrangler.json');
    try {
      writeFileSync(generatedPath, JSON.stringify({ name: 'app', triggers: { crons: [] } }));
      writeFileSync(sourcePath, JSON.stringify({ name: 'app' }));
      expect(readCloudflareTriggerConfig(generatedPath, sourcePath)).toMatchObject({
        preserveRoutes: true,
        preserveWorkersDev: true,
        preservePreviewUrls: true,
        crons: [],
      });
      expect(readCloudflareTriggerConfig(generatedPath, sourcePath)).not.toHaveProperty('preserve');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails before upload when omitted existing visibility has no trusted snapshot', async () => {
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          { id: CURRENT, annotations: { 'workers/message': encodeCloudflareVersionMessage([]) } },
        ]),
      ),
    });
    const desired = triggersWith({
      preserveRoutes: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
      crons: ['0 * * * *'],
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        message: encodeCloudflareVersionMessage([], desired),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'traffic-preservation-unavailable' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('uses the last published traffic values while adding an ordinary cron', async () => {
    let applied: Record<string, unknown> | undefined;
    const base = runner();
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'triggers') {
        applied = readConfigArg(args);
        return ok();
      }
      return base(args);
    });
    const desired = triggersWith({
      preserveRoutes: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
      crons: ['0 * * * *'],
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        previousTrafficConfig: {
          workers_dev: false,
          preview_urls: true,
          routes: [{ pattern: 'app.example.com', custom_domain: true }],
        },
        message: encodeCloudflareVersionMessage([], desired),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(applied).toMatchObject({
      workers_dev: false,
      preview_urls: true,
      routes: [{ pattern: 'app.example.com', custom_domain: true }],
      triggers: { crons: ['0 * * * *'] },
    });
  });

  it('continues an opaque handoff for a later code-only deployment', async () => {
    const preserved = triggersWith({
      preserve: true,
      preserveRoutes: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
    });
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([], preserved) },
          },
        ]),
      ),
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        configPath: '/app/wrangler.json',
        verifyUploader: () => true,
        message: encodeCloudflareVersionMessage([], { ...preserved, preserve: undefined }),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, preservedTriggers: true });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('continues an opaque handoff with unchanged explicit routes', async () => {
    const route = { pattern: 'app.example.com', custom_domain: true };
    const preserved = triggersWith({
      preserve: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
      workers_dev: false,
      preview_urls: false,
      routes: [route],
    });
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([], preserved) },
          },
        ]),
      ),
    });
    const { preserve: _preserve, ...next } = preserved;
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        configPath: '/app/wrangler.json',
        verifyUploader: () => true,
        message: encodeCloudflareVersionMessage([], next),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, preservedTriggers: true });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('does not silently suppress changed settings after an opaque handoff', async () => {
    const preserved = triggersWith({
      preserve: true,
      preserveRoutes: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
      settingsHash: 'before',
    });
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([], preserved) },
          },
        ]),
      ),
    });
    const { preserve: _preserve, ...next } = preserved;
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'my-worker',
        verifyUploader: () => true,
        message: encodeCloudflareVersionMessage([], { ...next, settingsHash: 'after' }),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'traffic-preservation-unavailable' });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'upload')).toBe(false);
  });

  it('preserves Wrangler route-aware traffic defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-route-defaults-'));
    const configPath = join(directory, 'wrangler.json');
    try {
      writeFileSync(
        configPath,
        JSON.stringify({ name: 'app', routes: [{ pattern: 'app.example.com', zone_name: 'x' }] }),
      );
      expect(readCloudflareTriggerConfig(configPath)).toMatchObject({
        workers_dev: false,
        preview_urls: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('can reconcile non-route triggers without publishing a stale route snapshot', async () => {
    let applied: Record<string, unknown> | undefined;
    await deployCloudflareVersionTriggers({
      manageRoutes: false,
      runWrangler: operationFixture(async (args) => {
        applied = readConfigArg(args);
        return ok();
      }),
      workerName: 'app',
      triggerConfig: triggersWith({
        workers_dev: false,
        preview_urls: false,
        routes: [{ pattern: 'apps.example.com/*', zone_name: 'example.com' }],
        crons: ['0 * * * *'],
      }),
    });

    expect(applied).not.toHaveProperty('routes');
    expect(applied).toMatchObject({ triggers: { crons: ['0 * * * *'] } });
  });

  it('removes queue consumers omitted from the desired trigger snapshot', async () => {
    const calls: Array<Array<string>> = [];
    const result = await deployCloudflareVersionTriggers({
      runWrangler: operationFixture(async (args) => {
        calls.push(args);
        return ok();
      }),
      workerName: 'app',
      triggerConfig: triggersWith(),
      previousTriggerConfig: triggersWith({ queueConsumers: [{ queue: 'jobs' }] }),
    });

    expect(result.status).toBe(0);
    expect(calls[1]).toEqual([
      'queues',
      'consumer',
      'remove',
      'jobs',
      'app',
      '-c',
      expect.any(String),
      '--env=',
    ]);
  });

  it('clears schedules without deleting removed workflow state', async () => {
    let applied: Record<string, unknown> | undefined;
    await deployCloudflareVersionTriggers({
      runWrangler: operationFixture(async (args) => {
        applied = readConfigArg(args);
        return ok();
      }),
      workerName: 'app',
      triggerConfig: triggersWith(),
      previousTriggerConfig: triggersWith({
        workflows: [{ name: 'nightly', class_name: 'NightlyWorkflow', schedules: ['0 0 * * *'] }],
      }),
    });

    expect(applied?.workflows).toEqual([
      { name: 'nightly', class_name: 'NightlyWorkflow', schedules: [] },
    ]);
  });

  it('publishes an explicit empty set when removing the final custom domain', async () => {
    const publishEmptyCustomDomains = vi.fn(async () => ok());
    const result = await deployCloudflareVersionTriggers({
      runWrangler: operationFixture(async () => ok()),
      workerName: 'app',
      triggerConfig: triggersWith(),
      previousTriggerConfig: customDomainTriggers('app.example.com'),
      publishEmptyCustomDomains,
    });

    expect(result.status).toBe(0);
    expect(publishEmptyCustomDomains).toHaveBeenCalledOnce();
  });

  it('publishes an explicit empty Cron Trigger set and fails when Cloudflare rejects it', async () => {
    const publishEmptyCrons = operationFixture(async () => ({
      status: 1,
      stdout: '',
      stderr: 'rejected',
    }));
    const result = await deployCloudflareVersionTriggers({
      runWrangler: operationFixture(async () => ok()),
      workerName: 'app',
      triggerConfig: triggersWith(),
      previousTriggerConfig: triggersWith({ crons: ['0 * * * *'] }),
      publishEmptyCrons,
    });

    expect(publishEmptyCrons).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 1, stderr: 'rejected' });
  });

  it('normalizes and extracts workers.dev account subdomains', () => {
    expect(normalizeWorkersDevSubdomain('Developer-Platform-Experience.workers.dev/')).toBe(
      'developer-platform-experience',
    );
    expect(normalizeWorkersDevSubdomain('not valid')).toBeUndefined();
    expect(normalizeWorkersDevSubdomain('My-Team.fed.workers.dev')).toBe('my-team.fed');
    expect(
      extractWorkersDevSubdomain(
        'https://void-ready-abc-my-worker.developer-platform-experience.workers.dev/path',
      ),
    ).toBe('developer-platform-experience');
    expect(
      extractWorkersDevSubdomain('https://void-ready-abc-my-worker.my-team.fed.workers.dev/path'),
    ).toBe('my-team.fed');
    expect(extractWorkersDevSubdomain('https://example.com')).toBeUndefined();
    expect(extractWorkersDevSubdomain('https://worker.my-team.other.workers.dev')).toBeUndefined();
  });

  it('round-trips migration metadata and rejects unrelated annotations', () => {
    const message = encodeCloudflareVersionMessage(['0001_init.sql', '0002_users.sql']);
    expect(parseCloudflareVersionMessage(message)).toEqual({
      schema: 1,
      migrations: ['0001_init.sql', '0002_users.sql'],
    });
    expect(parseCloudflareVersionMessage('manual deploy')).toBeNull();
    expect(parseCloudflareVersionMessage('void:{bad')).toBeNull();
  });

  it('round-trips an upload digest only when it is a valid SHA-256 value', () => {
    const triggers = triggersWith({ preview_urls: false });
    const digest = 'a'.repeat(64);
    expect(
      parseCloudflareVersionMessage(encodeCloudflareVersionMessage([], triggers, digest)),
    ).toMatchObject({ contentHash: digest });
    expect(
      parseCloudflareVersionMessage(
        `void:${JSON.stringify({ schema: 2, migrations: [], triggerConfig: triggers, contentHash: 'bad' })}`,
      ),
    ).not.toHaveProperty('contentHash');
  });

  // The Cloudflare CLI applies its Email Routing plan inside `triggers deploy`, reading the
  // config's `addresses`. The trigger-only config Void hands it must therefore carry the
  // snapshot's addresses verbatim — and carry NOTHING when the snapshot has none, because an
  // absent key skips the plan while `[]` deletes every rule the Worker owns.
  it('snapshots explicit observability and restores it without borrowing local settings', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-observability-'));
    const configPath = join(directory, 'wrangler.json');
    const sourcePath = join(directory, 'source.json');
    const observability = {
      enabled: true,
      head_sampling_rate: 0.25,
      logs: { enabled: true, invocation_logs: false },
      traces: { enabled: true, head_sampling_rate: 0.1 },
    };
    try {
      writeFileSync(configPath, JSON.stringify({ name: 'app', observability }));
      const snapshot = readCloudflareTriggerConfig(configPath);
      expect(snapshot).toMatchObject({ observability });
      expect(parseCloudflareVersionMessage(encodeCloudflareVersionMessage([], snapshot))).toEqual({
        schema: 2,
        migrations: [],
        triggerConfig: snapshot,
      });

      writeFileSync(configPath, JSON.stringify({ name: 'app', observability: { enabled: false } }));
      let applied: Record<string, unknown> | undefined;
      const publish = async (triggerConfig: CloudflareTriggerConfig, preserveTriggers = false) =>
        deployCloudflareVersionTriggers({
          runWrangler: operationFixture(async (args) => {
            applied = readConfigArg(args);
            return ok();
          }),
          workerName: 'app',
          configPath,
          triggerConfig: preserveTriggers ? { ...triggerConfig, preserve: true } : triggerConfig,
        });
      await publish(snapshot);
      expect(applied).toMatchObject({ observability });
      const disabled = readCloudflareTriggerConfig(configPath);
      await publish(disabled);
      expect(applied).toMatchObject({ observability: { enabled: false } });

      // Generated defaults must not turn an omitted source setting into an update.
      writeFileSync(sourcePath, JSON.stringify({ name: 'app' }));
      const omitted = readCloudflareTriggerConfig(configPath, sourcePath);
      expect(omitted).not.toHaveProperty('observability');
      await publish(omitted);
      expect(applied).not.toHaveProperty('observability');
      applied = undefined;
      await publish(snapshot, true);
      expect(applied).toBeUndefined();
      expect(
        parseCloudflareVersionMessage(
          `void:${JSON.stringify({ schema: 2, migrations: [], triggerConfig: { ...snapshot, observability: null } })}`,
        ),
      ).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('carries Email Routing addresses through the trigger snapshot and the trigger config', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-version-addresses-'));
    const configPath = join(directory, 'wrangler.json');
    const applied = async (
      triggerConfig: Parameters<typeof deployCloudflareVersionTriggers>[0]['triggerConfig'],
    ): Promise<Record<string, unknown>> => {
      let config: Record<string, unknown> | undefined;
      await deployCloudflareVersionTriggers({
        runWrangler: operationFixture(async (args) => {
          config = readConfigArg(args);
          return ok();
        }),
        workerName: 'app',
        configPath,
        triggerConfig,
      });
      return config!;
    };
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          name: 'app',
          account_id: 'account',
          send_email: [{ name: 'SEND_EMAIL' }],
          addresses: ['support@mail.acme.com', 'billing@mail.acme.com'],
        }),
      );
      const withAddresses = readCloudflareTriggerConfig(configPath);
      expect(withAddresses.addresses).toEqual(['support@mail.acme.com', 'billing@mail.acme.com']);
      expect(await applied(withAddresses)).toMatchObject({
        addresses: ['support@mail.acme.com', 'billing@mail.acme.com'],
      });
      // The annotation round-trips the addresses, so a rollback restores that version's rules.
      expect(
        parseCloudflareVersionMessage(encodeCloudflareVersionMessage([], withAddresses)),
      ).toEqual({ schema: 2, migrations: [], triggerConfig: withAddresses });

      // An explicit empty array is a destructive plan and must survive as `[]`, not vanish.
      writeFileSync(configPath, JSON.stringify({ name: 'app', addresses: [] }));
      const emptied = readCloudflareTriggerConfig(configPath);
      expect(emptied.addresses).toEqual([]);
      expect(await applied(emptied)).toMatchObject({ addresses: [] });

      // No `addresses` at all — the key must not reach Wrangler, or it would plan on it.
      writeFileSync(configPath, JSON.stringify({ name: 'app', account_id: 'account' }));
      const without = readCloudflareTriggerConfig(configPath);
      expect(without).not.toHaveProperty('addresses');
      expect(await applied(without)).not.toHaveProperty('addresses');
      // A rollback replays the target snapshot only; the version being left never lends its
      // addresses, so a target without `addresses` skips the plan instead of sending `[]`.
      let rollbackConfig: Record<string, unknown> | undefined;
      await deployCloudflareVersionTriggers({
        runWrangler: operationFixture(async (args) => {
          rollbackConfig = readConfigArg(args);
          return ok();
        }),
        workerName: 'app',
        configPath,
        triggerConfig: without,
        previousTriggerConfig: withAddresses,
      });
      expect(rollbackConfig).not.toHaveProperty('addresses');
      // A malformed array is not an address list; treat it as absent rather than planning on it.
      writeFileSync(configPath, JSON.stringify({ name: 'app', addresses: [{ bad: true }] }));
      expect(readCloudflareTriggerConfig(configPath)).not.toHaveProperty('addresses');
      expect(
        parseCloudflareVersionMessage(
          `void:${JSON.stringify({ schema: 2, migrations: [], triggerConfig: { ...without, addresses: 'support@mail.acme.com' } })}`,
        ),
      ).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uploads, probes, activates, and applies triggers in order', async () => {
    const runWrangler = runner();
    const fetcher = vi.fn(async () => Response.json({ ready: true }));
    const phases: Array<string> = [];
    const result = await activateCloudflareVersion({
      runWrangler,
      onProgress: (phase) => phases.push(phase),
      verifyUploader: () => true,
      workerName: 'my-worker',
      configPath: '/app/wrangler.jsonc',
      assetsDirectoryOverride: '/app/.void/deploy/cloudflare/assets',
      message: encodeCloudflareVersionMessage(['0001_init.sql']),
      fetch: fetcher,
      sleep: async () => {},
    });

    expect(result).toEqual({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://my-worker.example.workers.dev',
      previousVersionId: CURRENT,
      trafficConfig: {
        workers_dev: true,
        preview_urls: true,
        routes: [],
      },
      workersDevSubdomain: 'example',
    });
    expect(phases).toEqual([
      'Checking the current Worker deployment...',
      'Uploading the Worker and assets...',
      'Verifying the uploaded Worker...',
      'Waiting for the Worker to become ready...',
      'Activating the Worker...',
      'Updating routes and triggers...',
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://ready.example.workers.dev/__void/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['deployments', 'status'],
      ['versions', 'deploy'],
      ['deployments', 'status'],
      ['triggers', 'deploy'],
      ['deployments', 'status'],
    ]);
    expect(runWrangler.mock.calls[1]![0]).toContain('--assets');
    expect(runWrangler.mock.calls[1]![0]).toContain('/app/.void/deploy/cloudflare/assets');
    expect(runWrangler.mock.calls[3]![0]).toContain(`${NEXT}@100`);
    expect(runWrangler.mock.calls[5]![0]).toEqual([
      'triggers',
      'deploy',
      '-c',
      expect.stringContaining('void-version-triggers-'),
      '--env=',
      '--name',
      'my-worker',
    ]);
  });

  it('repairs triggers for a rollback that wins while deployment activation is in flight', async () => {
    const activation = deferred<CloudflareCommandResult>();
    const activationStarted = deferred<void>();
    let activeVersionId = CURRENT;
    let appliedTriggerConfig: Record<string, unknown> | undefined;
    const concurrentTriggerConfig = triggersWith({
      crons: ['concurrent'],
      queueConsumers: [{ queue: 'concurrent-jobs' }],
    });
    const runWrangler = operationFixture(async (args: Array<string>) => {
      if (args[0] === 'deployments') {
        return ok(JSON.stringify({ versions: [{ version_id: activeVersionId, percentage: 100 }] }));
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        return ok(
          `Worker Version ID: ${NEXT}\nVersion Preview URL: https://ready.example.workers.dev`,
        );
      }
      if (args[0] === 'versions' && args[1] === 'deploy') {
        activeVersionId = NEXT;
        activationStarted.resolve(undefined);
        return activation.promise;
      }
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(
          JSON.stringify([
            {
              id: CONCURRENT,
              annotations: {
                'workers/message': encodeCloudflareVersionMessage([], concurrentTriggerConfig),
              },
            },
          ]),
        );
      }
      if (args[0] === 'triggers') {
        appliedTriggerConfig = readConfigArg(args);
        return ok();
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const pending = activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([], triggersWith({ crons: ['deploy'] })),
      fetch: async () => Response.json({ ready: true }),
    });
    await activationStarted.promise;
    activeVersionId = CONCURRENT;
    activation.resolve(ok());

    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: CONCURRENT,
      triggerRepair: 'succeeded',
    });
    expect(appliedTriggerConfig).toMatchObject({
      triggers: { crons: ['concurrent'] },
      queues: { consumers: [{ queue: 'concurrent-jobs' }] },
    });
  });

  it('removes explicitly owned legacy consumers when the previous metadata is schema 1', async () => {
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([]) },
          },
        ]),
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([], triggersWith()),
        queueConsumerCleanup: ['legacy-jobs'],
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      runWrangler.mock.calls.find(
        ([args]) => args[0] === 'queues' && args[1] === 'consumer' && args[2] === 'remove',
      )?.[0],
    ).toEqual([
      'queues',
      'consumer',
      'remove',
      'legacy-jobs',
      'my-worker',
      '-c',
      expect.any(String),
      '--env=',
    ]);
  });

  it('replays the previous snapshot addresses when managed-queue cleanup rebuilds it', async () => {
    // `queueConsumerCleanup` is non-empty on EVERY deploy of a project with Void-managed
    // consumers (`readWranglerManagedQueueCleanupCandidates` includes the current consumers
    // for schema-1 upgrades), so the rebuilt previous config is what `stabilize…` replays when
    // a concurrent rollback returns traffic to the previous version. Wrangler's Email Routing
    // plan takes no "previous" list — it reconciles to exactly the replayed `addresses`, and
    // skips the plan when the key is absent — so the copy must keep that version's own value:
    // absent, `[]`, and a list are three different plans.
    const replayed = async (
      previousAddresses: ReadonlyArray<string> | undefined,
    ): Promise<Record<string, unknown>> => {
      const activation = deferred<CloudflareCommandResult>();
      const activationStarted = deferred<void>();
      let activeVersionId = CURRENT;
      let appliedTriggerConfig: Record<string, unknown> | undefined;
      const previousTriggerConfig = triggersWith(
        previousAddresses === undefined ? {} : { addresses: previousAddresses },
      );
      const runWrangler = operationFixture(async (args: Array<string>) => {
        if (args[0] === 'deployments') {
          return ok(
            JSON.stringify({ versions: [{ version_id: activeVersionId, percentage: 100 }] }),
          );
        }
        if (args[0] === 'versions' && args[1] === 'upload') {
          return ok(
            `Worker Version ID: ${NEXT}\nVersion Preview URL: https://ready.example.workers.dev`,
          );
        }
        if (args[0] === 'versions' && args[1] === 'deploy') {
          activeVersionId = NEXT;
          activationStarted.resolve(undefined);
          return activation.promise;
        }
        if (args[0] === 'versions' && args[1] === 'list') {
          return ok(
            JSON.stringify([
              {
                id: CURRENT,
                annotations: {
                  'workers/message': encodeCloudflareVersionMessage([], previousTriggerConfig),
                },
              },
            ]),
          );
        }
        if (args[0] === 'triggers') {
          appliedTriggerConfig = readConfigArg(args);
          return ok();
        }
        if (args[0] === 'queues') {
          return ok();
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      });

      const pending = activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage(
          [],
          triggersWith({ addresses: ['billing@mail.acme.com'] }),
        ),
        queueConsumerCleanup: ['jobs'],
        fetch: async () => Response.json({ ready: true }),
      });
      await activationStarted.promise;
      // A concurrent rollback to the previous version wins before triggers are published.
      activeVersionId = CURRENT;
      activation.resolve(ok());

      await expect(pending).resolves.toMatchObject({
        ok: false,
        reason: 'deployment-changed',
        activeVersionId: CURRENT,
        triggerRepair: 'succeeded',
      });
      return appliedTriggerConfig!;
    };

    expect(await replayed(['support@mail.acme.com'])).toMatchObject({
      addresses: ['support@mail.acme.com'],
      queues: { consumers: [{ queue: 'jobs' }] },
    });
    expect(await replayed([])).toMatchObject({ addresses: [] });
    expect(await replayed(undefined)).not.toHaveProperty('addresses');
  });

  it('does not compensate over a concurrent owner after trigger failure', async () => {
    const failedTriggers = deferred<CloudflareCommandResult>();
    const triggerStarted = deferred<void>();
    let activeVersionId = CURRENT;
    let triggerCalls = 0;
    let repairedConfig: Record<string, unknown> | undefined;
    const configFor = (cron: string) => triggersWith({ crons: [cron] });
    const runWrangler = operationFixture(async (args: Array<string>) => {
      if (args[0] === 'deployments') {
        return ok(JSON.stringify({ versions: [{ version_id: activeVersionId, percentage: 100 }] }));
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        return ok(
          `Worker Version ID: ${NEXT}\nVersion Preview URL: https://ready.example.workers.dev`,
        );
      }
      if (args[0] === 'versions' && args[1] === 'deploy') {
        activeVersionId = NEXT;
        return ok();
      }
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(
          JSON.stringify(
            [
              [CURRENT, configFor('current')],
              [CONCURRENT, configFor('concurrent')],
            ].map(([id, triggerConfig]) => ({
              id,
              annotations: {
                'workers/message': encodeCloudflareVersionMessage(
                  [],
                  triggerConfig as ReturnType<typeof configFor>,
                ),
              },
            })),
          ),
        );
      }
      if (args[0] === 'triggers') {
        triggerCalls++;
        if (triggerCalls === 1) {
          triggerStarted.resolve(undefined);
          return failedTriggers.promise;
        }
        repairedConfig = readConfigArg(args);
        return ok();
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const pending = activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([], configFor('next')),
      fetch: async () => Response.json({ ready: true }),
    });
    await triggerStarted.promise;
    activeVersionId = CONCURRENT;
    failedTriggers.resolve({ ...ok(), status: 1 });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: CONCURRENT,
      rollback: 'not-needed',
      triggerRepair: 'succeeded',
    });
    expect(repairedConfig).toMatchObject({ triggers: { crons: ['concurrent'] } });
    expect(
      runWrangler.mock.calls.filter(([args]) => args[0] === 'versions' && args[1] === 'deploy'),
    ).toHaveLength(1);
  });

  it('uses newer published traffic provenance instead of a stale version annotation', async () => {
    const staleTriggerConfig = customDomainTriggers('old.example.com');
    const desiredTriggerConfig = {
      ...staleTriggerConfig,
      workers_dev: true,
      preview_urls: true,
      routes: [],
    };
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: {
              'workers/message': encodeCloudflareVersionMessage([], staleTriggerConfig),
            },
          },
        ]),
      ),
    });
    const publishEmptyCustomDomains = vi.fn(async () => ok());

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([], desiredTriggerConfig),
        previousTrafficConfig: {
          workers_dev: true,
          preview_urls: true,
          routes: [],
        },
        publishEmptyCustomDomains,
        fetch: async () => Response.json({ ready: true }),
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(publishEmptyCustomDomains).not.toHaveBeenCalled();
  });

  it('does not activate a version whose preview never becomes ready', async () => {
    const base = runner();
    let secretsPath: string | undefined;
    let uploadedSecrets: unknown;
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'upload') {
        secretsPath = args[args.indexOf('--secrets-file') + 1];
        uploadedSecrets = JSON.parse(readFileSync(secretsPath!, 'utf8'));
        if (process.platform !== 'win32') {
          expect(statSync(secretsPath!).mode & 0o777).toBe(0o600);
        }
      }
      return base(args);
    });
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([]),
      candidateSecrets: { API_TOKEN: 'next-secret' },
      fetch: async () => new Response('not ready', { status: 503 }),
      sleep: async () => {},
      readinessAttempts: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      versionId: NEXT,
      rollback: 'not-needed',
    });
    expect(uploadedSecrets).toEqual({ API_TOKEN: 'next-secret' });
    expect(runWrangler.mock.calls.flatMap(([args]) => args)).not.toContain('next-secret');
    expect(secretsPath && existsSync(secretsPath)).toBe(false);
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('sends Access service-token headers only to the matching Workers preview host', async () => {
    const runWrangler = runner({
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
      ),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'attacker-account',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: {
          'CF-Access-Client-Id': 'service-id',
          'CF-Access-Client-Secret': 'service-secret',
        },
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(fetcher).toHaveBeenCalledWith(
      'https://void-ready-abc-my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'CF-Access-Client-Id': 'service-id',
          'CF-Access-Client-Secret': 'service-secret',
        }),
        redirect: 'manual',
      }),
    );
  });

  it('never forwards Access service-token headers to an unrelated readiness host', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://attacker.example`),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: {
          'CF-Access-Client-Id': 'service-id',
          'CF-Access-Client-Secret': 'service-secret',
        },
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'readiness-failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls back from an Access-blocked preview alias to the stable Worker hostname', async () => {
    const runWrangler = runner({
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
      ),
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('error code: 1050', { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://my-worker.developer-platform-experience.workers.dev',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      'https://my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Cloudflare-Workers-Version-Overrides': `my-worker="${NEXT}"`,
        }),
      }),
    );
    const deployCalls = runWrangler.mock.calls.filter(
      ([args]) => args[0] === 'versions' && args[1] === 'deploy',
    );
    expect(deployCalls[0]![0]).toEqual(expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]));
    expect(deployCalls[1]![0]).toContain(`${NEXT}@100`);
  });

  it('never sends Access headers to an unverified cached workers.dev subdomain', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'stale-or-attacker',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: { 'CF-Access-Token': 'secret' },
        fetch: fetcher,
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'readiness-failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends Access headers to an explicitly trusted workers.dev fallback', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        readinessHeadersWorkersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        readinessHeaders: { 'cf-access-token': 'short-lived-user-jwt' },
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({ ok: true, versionId: NEXT });
    expect(fetcher).toHaveBeenCalledWith(
      'https://my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'cf-access-token': 'short-lived-user-jwt',
          'Cloudflare-Workers-Version-Overrides': `my-worker="${NEXT}"`,
        }),
      }),
    );
  });

  it('restores the prior deployment when Access blocks both readiness hostnames', async () => {
    const runWrangler = runner({
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
      ),
    });
    const fetcher = vi.fn(async () => new Response('error code: 1050', { status: 403 }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-access-denied',
      rollback: 'succeeded',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const deployCalls = runWrangler.mock.calls.filter(
      ([args]) => args[0] === 'versions' && args[1] === 'deploy',
    );
    expect(deployCalls[0]![0]).toEqual(expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]));
    expect(deployCalls[1]![0]).toContain(`${CURRENT}@100`);
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('leaves a first uploaded version inactive when its preview alias is Access-blocked', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      upload: ok(
        `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-first.developer-platform-experience.workers.dev`,
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('error code: 1050', { status: 403 }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-access-denied',
      rollback: 'not-needed',
    });
    expect(runWrangler.mock.calls.some(([args]) => args[1] === 'deploy')).toBe(false);
  });

  it('refuses to flatten an existing gradual traffic split', async () => {
    const runWrangler = runner({
      status: ok(
        JSON.stringify({
          versions: [
            { version_id: CURRENT, percentage: 90 },
            { version_id: NEXT, percentage: 10 },
          ],
        }),
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({ ok: false, reason: 'traffic-split-unsupported' });
    expect(runWrangler).toHaveBeenCalledTimes(1);
  });

  it('verifies the uploader before reading credentialed deployment status', async () => {
    const runWrangler = runner();

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => false,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({ ok: false, reason: 'uploader-changed' });
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('fails closed when Wrangler does not return a preview URL', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'preview-unavailable', versionId: NEXT });
  });

  it('probes a zero-percent Durable Object version through a production workers.dev URL', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://my-worker.developer-platform-experience.workers.dev',
    });

    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['versions', 'list'],
      ['deployments', 'status'],
      ['versions', 'deploy'],
      ['deployments', 'status'],
      ['versions', 'deploy'],
      ['deployments', 'status'],
      ['triggers', 'deploy'],
      ['deployments', 'status'],
    ]);
    const deployCalls = runWrangler.mock.calls.filter(
      ([args]) => args[0] === 'versions' && args[1] === 'deploy',
    );
    expect(deployCalls[0]![0]).toEqual(expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]));
    expect(deployCalls[1]![0]).toContain(`${NEXT}@100`);
    expect(fetcher).toHaveBeenCalledWith(
      'https://my-worker.developer-platform-experience.workers.dev/__void/ready',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Cloudflare-Workers-Version-Overrides': `my-worker="${NEXT}"`,
        }),
      }),
    );
  });

  it('does not stage over a production owner that changed after upload', async () => {
    let statusCalls = 0;
    const runWrangler = operationFixture(async (args: Array<string>) => {
      if (args[0] === 'deployments') {
        statusCalls++;
        const versionId = statusCalls === 1 ? CURRENT : CONCURRENT;
        return ok(JSON.stringify({ versions: [{ version_id: versionId, percentage: 100 }] }));
      }
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(JSON.stringify([{ id: CURRENT, annotations: {} }]));
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        return ok(`Worker Version ID: ${NEXT}`);
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: CONCURRENT,
      rollback: 'not-needed',
    });
    expect(
      runWrangler.mock.calls.some(([args]) => args[0] === 'versions' && args[1] === 'deploy'),
    ).toBe(false);
  });

  it('does not use Access fallback staging after a concurrent activation', async () => {
    let statusCalls = 0;
    const runWrangler = operationFixture(async (args: Array<string>) => {
      if (args[0] === 'deployments') {
        statusCalls++;
        const versionId = statusCalls === 1 ? CURRENT : CONCURRENT;
        return ok(JSON.stringify({ versions: [{ version_id: versionId, percentage: 100 }] }));
      }
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(JSON.stringify([{ id: CURRENT, annotations: {} }]));
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        return ok(
          `Worker Version ID: ${NEXT}\nVersion Preview Alias URL: https://void-ready-abc-my-worker.developer-platform-experience.workers.dev`,
        );
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('error code: 1050', { status: 403 }),
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'deployment-changed',
      activeVersionId: CONCURRENT,
      rollback: 'not-needed',
    });
    expect(
      runWrangler.mock.calls.some(([args]) => args[0] === 'versions' && args[1] === 'deploy'),
    ).toBe(false);
  });

  it('restores the prior deployment when a zero-percent version is not ready', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('not ready', { status: 503 }),
        sleep: async () => {},
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      rollback: 'succeeded',
    });

    const deployCalls = runWrangler.mock.calls.filter(
      ([args]) => args[0] === 'versions' && args[1] === 'deploy',
    );
    expect(deployCalls[0]![0]).toEqual(expect.arrayContaining([`${CURRENT}@100`, `${NEXT}@0`]));
    expect(deployCalls[1]![0]).toContain(`${CURRENT}@100`);
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('does not restore failed readiness staging over a concurrent candidate', async () => {
    let deploymentVersions = [{ version_id: CURRENT, percentage: 100 }];
    let deployCalls = 0;
    const runWrangler = operationFixture(async (args: Array<string>) => {
      if (args[0] === 'deployments') {
        return ok(JSON.stringify({ versions: deploymentVersions }));
      }
      if (args[0] === 'versions' && args[1] === 'list') {
        return ok(JSON.stringify([{ id: CURRENT, annotations: {} }]));
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        return ok(`Worker Version ID: ${NEXT}`);
      }
      if (args[0] === 'versions' && args[1] === 'deploy') {
        deployCalls++;
        deploymentVersions = [
          { version_id: CURRENT, percentage: 100 },
          { version_id: NEXT, percentage: 0 },
        ];
        return ok();
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => {
          deploymentVersions = [
            { version_id: CURRENT, percentage: 100 },
            { version_id: CONCURRENT, percentage: 0 },
          ];
          return new Response('not ready', { status: 503 });
        },
        sleep: async () => {},
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      rollback: 'unsafe',
    });
    expect(deployCalls).toBe(1);
    expect(deploymentVersions).toEqual([
      { version_id: CURRENT, percentage: 100 },
      { version_id: CONCURRENT, percentage: 0 },
    ]);
  });

  it('does not invoke a changed uploader to restore zero-percent staging', async () => {
    const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
    let verification = 0;

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => ++verification < 4,
        workerName: 'my-worker',
        workersDevSubdomain: 'developer-platform-experience',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('not ready', { status: 503 }),
        sleep: async () => {},
        readinessAttempts: 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'readiness-failed',
      rollback: 'unsafe',
    });

    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['versions', 'list'],
      ['deployments', 'status'],
      ['versions', 'deploy'],
    ]);
  });

  it('bootstraps a proven first deploy when account preview URLs are disabled', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}`),
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-with-secret',
        message: encodeCloudflareVersionMessage([]),
        allowFirstDeploymentBootstrap: true,
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      previewUrl: 'https://first-with-secret.example.workers.dev',
    });
    expect(runWrangler.mock.calls.map(([args]) => args[0])).toEqual([
      'deployments',
      'versions',
      'deployments',
      'deploy',
      'deployments',
      'deployments',
      'triggers',
      'deployments',
      'deployments',
    ]);
  });

  it('waits for a new Worker to propagate beyond the normal preview retry window', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}`),
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });
    let probes = 0;
    const cancel = vi.fn();
    const sleep = vi.fn(async () => {});
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'first',
      message: encodeCloudflareVersionMessage([]),
      allowFirstDeploymentBootstrap: true,
      sleep,
      fetch: async () => {
        probes++;
        return probes <= 8
          ? new Response(new ReadableStream({ cancel }), { status: 404 })
          : Response.json({ ready: true });
      },
    });
    expect(result).toMatchObject({ ok: true, versionId: NEXT });
    expect(probes).toBe(9);
    expect(cancel).toHaveBeenCalledTimes(8);
    expect(runWrangler.mock.calls.filter(([args]) => args[0] === 'deploy')).toHaveLength(1);
  });

  it('bounds a first-deploy readiness wait by elapsed time and fails closed', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}`),
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });
    let time = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    let probes = 0;
    try {
      const result = await activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        allowFirstDeploymentBootstrap: true,
        readinessAttempts: 100,
        sleep: async (milliseconds) => {
          time += milliseconds;
        },
        fetch: async () => {
          probes++;
          time += 10_000;
          return new Response(null, { status: 503 });
        },
      });
      expect(result).toMatchObject({ ok: false, reason: 'bootstrap-readiness-failed' });
      expect(probes).toBeLessThanOrEqual(6);
      expect(time).toBeLessThanOrEqual(70_000);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    { atomic: false, becomesReady: true, timeout: 300_000 },
    { atomic: false, becomesReady: false, timeout: 300_000 },
    { atomic: true, becomesReady: false, timeout: 60_000 },
  ])(
    'bounds Custom Domain propagation to $timeout ms (atomic=$atomic, ready=$becomesReady)',
    async ({ atomic, becomesReady, timeout }) => {
      const runWrangler = runner({
        ...(atomic
          ? {}
          : {
              status: { stdout: '', stderr: 'Worker not found. [code: 10007]', status: 1 },
              upload: { stdout: '', stderr: LOCAL_DURABLE_MIGRATION_ERROR, status: 1 },
            }),
        bootstrap: ok(`Current Version ID: ${NEXT}`),
      });
      let time = 0;
      let probes = 0;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
      try {
        const result = await activateCloudflareVersion({
          runWrangler,
          verifyUploader: () => true,
          workerName: 'custom-app',
          atomic,
          message: encodeCloudflareVersionMessage([], customDomainTriggers('app.example.com')),
          sleep: async (milliseconds) => {
            time += milliseconds;
          },
          fetch: async (url, options) => {
            expect(url).toBe('https://app.example.com/__void/ready');
            expect(options?.headers).toEqual({ 'user-agent': 'void-deploy-readiness/1' });
            probes++;
            time += 2_000;
            if (becomesReady && probes > 30) {
              return Response.json({ ready: true });
            }
            throw new Error('getaddrinfo ENOTFOUND app.example.com');
          },
        });
        if (becomesReady) {
          expect(result).toMatchObject({ ok: true, versionId: NEXT });
          expect(probes).toBe(31);
          expect(time).toBeGreaterThan(60_000);
        } else {
          expect(result).toMatchObject({
            ok: false,
            reason: atomic ? 'atomic-readiness-failed' : 'bootstrap-readiness-failed',
            diagnostic: expect.stringContaining('retry `void deploy --platform cloudflare`'),
          });
        }
        expect(time).toBeLessThanOrEqual(timeout + 2_000);
        expect(probes).toBeLessThanOrEqual(Math.ceil(timeout / 2_000));
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('rolls traffic back when trigger activation fails', async () => {
    const runWrangler = runner({ triggers: { ...ok(), status: 1 } });
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => Response.json({ ready: true }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'triggers-failed',
      rollback: 'succeeded',
      previousVersionId: CURRENT,
    });
    expect(
      runWrangler.mock.calls.some(([args]) =>
        args.some((argument) => argument === `${CURRENT}@100`),
      ),
    ).toBe(true);
    expect(runWrangler.mock.calls.filter(([args]) => args[0] === 'triggers')).toHaveLength(2);
  });

  it('restores live traffic changes made after the previous version upload', async () => {
    const immutable = triggersWith({
      routes: [{ pattern: 'old.example.com', custom_domain: true }],
      crons: ['0 * * * *'],
      observability: { enabled: false },
    });
    const liveTraffic = {
      workers_dev: false,
      preview_urls: false,
      routes: [...immutable.routes, { pattern: 'production.example.com', custom_domain: true }],
    };
    const base = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            number: 1,
            annotations: {
              'workers/message': encodeCloudflareVersionMessage([], immutable),
            },
          },
        ]),
      ),
      triggers: { ...ok(), status: 1 },
    });
    const publications: Array<Record<string, unknown>> = [];
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'triggers') {
        publications.push(readConfigArg(args));
      }
      return base(args);
    });
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      previousTrafficConfig: liveTraffic,
      queueConsumerCleanup: ['orphaned-queue'],
      message: encodeCloudflareVersionMessage([], {
        ...immutable,
        preserveRoutes: true,
        preserveWorkersDev: true,
        preservePreviewUrls: true,
        crons: ['*/10 * * * *'],
        observability: { enabled: true, traces: { enabled: true } },
      }),
      fetch: async () => Response.json({ ready: true }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'triggers-failed', rollback: 'succeeded' });
    expect(publications).toHaveLength(2);
    expect(publications[0]).toMatchObject({
      ...liveTraffic,
      triggers: { crons: ['*/10 * * * *'] },
      observability: { enabled: true, traces: { enabled: true } },
    });
    expect(publications[1]).toMatchObject({
      ...liveTraffic,
      triggers: { crons: ['0 * * * *'] },
      observability: { enabled: false },
    });
    expect(publications[1].queues).toEqual({ consumers: [] });
  });

  it('does not claim opaque trigger recovery succeeded after restoring live traffic', async () => {
    const opaque = triggersWith({
      preserve: true,
      preserveRoutes: true,
      preserveWorkersDev: true,
      preservePreviewUrls: true,
    });
    const liveTraffic = {
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'production.example.com', custom_domain: true }],
    };
    const runWrangler = runner({
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            number: 1,
            annotations: {
              'workers/message': encodeCloudflareVersionMessage([], opaque),
            },
          },
        ]),
      ),
      triggers: { ...ok(), status: 1 },
    });

    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'my-worker',
      previousTrafficConfig: liveTraffic,
      message: encodeCloudflareVersionMessage([], {
        ...opaque,
        preserve: undefined,
        crons: ['*/10 * * * *'],
      }),
      fetch: async () => Response.json({ ready: true }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'triggers-failed',
      rollback: 'unavailable',
      previousVersionId: CURRENT,
    });
    expect(
      runWrangler.mock.calls.some(([args]) =>
        args.some((argument) => argument === `${CURRENT}@100`),
      ),
    ).toBe(true);
    expect(runWrangler.mock.calls.filter(([args]) => args[0] === 'triggers')).toHaveLength(1);
  });

  it('does not claim trigger rollback succeeded without prior trigger metadata', async () => {
    const runWrangler = runner({
      triggers: { ...ok(), status: 1 },
      versions: ok(
        JSON.stringify([
          {
            id: CURRENT,
            annotations: { 'workers/message': encodeCloudflareVersionMessage([]) },
          },
        ]),
      ),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'my-worker',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'triggers-failed',
      rollback: 'unavailable',
    });
    expect(runWrangler.mock.calls.filter(([args]) => args[0] === 'triggers')).toHaveLength(1);
  });

  it('does not invoke a changed uploader to roll traffic back after activation', async () => {
    const runWrangler = runner();
    let verification = 0;
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => ++verification < 4,
      workerName: 'my-worker',
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => Response.json({ ready: true }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'uploader-changed',
      rollback: 'unsafe',
      previousVersionId: CURRENT,
    });
    expect(runWrangler.mock.calls.at(-1)![0]).toContain(`${NEXT}@100`);
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'triggers')).toBe(false);
  });

  it('accepts the first deployment when status reports no deployments', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: null });
  });

  it('treats a missing Worker version list as an empty inheritance baseline', async () => {
    const base = runner({
      status: {
        stdout: '',
        stderr: 'This Worker does not exist on your account. [code: 10007]',
        status: 1,
      },
    });
    let uploaded = false;
    const runWrangler = operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'list') {
        return uploaded
          ? ok(JSON.stringify([{ id: NEXT, number: 1 }]))
          : { stdout: '', stderr: 'Worker not found. [code: 10007]', status: 1 };
      }
      if (args[0] === 'versions' && args[1] === 'upload') {
        uploaded = true;
      }
      return base(args);
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        verifyInheritedSecrets: true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: null });
  });

  it.each([undefined, CURRENT, CONCURRENT])(
    'rejects a stale custom-route readiness version %s before candidate activation',
    async (versionId) => {
      const runWrangler = runner({ upload: ok(`Worker Version ID: ${NEXT}`) });
      const result = await activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'private-app',
        requireVersionMetadata: true,
        readinessAttempts: 1,
        message: encodeCloudflareVersionMessage([], customDomainTriggers('app.example.com')),
        fetch: async () => Response.json({ ready: true, versionId }),
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'readiness-failed',
        rollback: 'succeeded',
      });
      const deployments = runWrangler.mock.calls.filter(
        ([args]) => args[0] === 'versions' && args[1] === 'deploy',
      );
      expect(deployments.some(([args]) => args.includes(`${NEXT}@100`))).toBe(false);
      expect(deployments[0]?.[0]).toContain(`${NEXT}@0`);
      expect(deployments.at(-1)?.[0]).toContain(`${CURRENT}@100`);
    },
  );

  it('waits for the actual candidate on a private custom route and ignores disabled previews', async () => {
    const runWrangler = runner();
    const sleep = vi.fn(async () => {});
    const fetcher = vi.fn(async () =>
      Response.json({ ready: true, versionId: fetcher.mock.calls.length === 1 ? CURRENT : NEXT }),
    );
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'private-app',
      requireVersionMetadata: true,
      readinessAttempts: 2,
      readinessHeaders: { 'CF-Access-Client-Secret': 'must-not-leak' },
      message: encodeCloudflareVersionMessage([], customDomainTriggers('app.example.com')),
      fetch: fetcher,
      sleep,
    });
    expect(result).toMatchObject({ ok: true, versionId: NEXT });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toBe('https://app.example.com/__void/ready');
      expect(init.headers).not.toHaveProperty('CF-Access-Client-Secret');
      expect(init.headers).toHaveProperty(
        'Cloudflare-Workers-Version-Overrides',
        `private-app="${NEXT}"`,
      );
    }
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'stable', 'wrong-version', 'access-denied', 'atomic'])(
    'fails closed for a binding-preserving handoff without a usable preview (%s)',
    async (scenario) => {
      const url =
        scenario === 'stable'
          ? 'https://handoff.example.workers.dev'
          : scenario === 'wrong-version'
            ? `https://${CURRENT.slice(0, 8)}-handoff.example.workers.dev`
            : `https://${NEXT.slice(0, 8)}-handoff.example.workers.dev`;
      const runWrangler = runner({
        upload: ok(
          `Worker Version ID: ${NEXT}${scenario === 'missing' ? '' : `\nVersion Preview URL: ${url}`}`,
        ),
      });
      const fetcher = vi.fn(async () => new Response('error code: 1050', { status: 403 }));
      const result = await activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'handoff',
        preserveTriggers: true,
        requirePreviewForReadiness: true,
        atomic: scenario === 'atomic',
        readinessAttempts: 1,
        message: encodeCloudflareVersionMessage([]),
        fetch: fetcher,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: scenario === 'access-denied' ? 'readiness-access-denied' : 'preview-unavailable',
      });
      expect(
        runWrangler.mock.calls.some(([args]) => args[0] === 'versions' && args[1] === 'deploy'),
      ).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(scenario === 'access-denied' ? 1 : 0);
    },
  );

  it('accepts a genuine immutable candidate preview without changing handoff bindings', async () => {
    const url = `https://${NEXT.slice(0, 8)}-handoff.example.workers.dev`;
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}\nVersion Preview URL: ${url}`),
    });
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'handoff',
      preserveTriggers: true,
      requirePreviewForReadiness: true,
      message: encodeCloudflareVersionMessage([]),
      fetch: async (value) => {
        expect(value).toBe(`${url}/__void/ready`);
        return Response.json({ ready: true });
      },
    });
    expect(result).toMatchObject({ ok: true, versionId: NEXT });
  });

  it('probes a custom route when workers.dev and preview URLs are disabled', async () => {
    const runWrangler = runner({
      upload: ok(`Worker Version ID: ${NEXT}`),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));
    const triggerConfig = triggersWith({
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'app.example.com/*', zone_name: 'example.com' }],
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'private-app',
        workersDevSubdomain: 'account',
        readinessHeaders: { 'CF-Access-Client-Secret': 'must-not-leak' },
        message: encodeCloudflareVersionMessage([], triggerConfig),
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({ ok: true, previewUrl: 'https://app.example.com' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://app.example.com/__void/ready',
      expect.objectContaining({
        headers: {
          'user-agent': 'void-deploy-readiness/1',
          'Cloudflare-Workers-Version-Overrides': `private-app="${NEXT}"`,
        },
      }),
    );
  });

  it.each([false, true])('requires the served UUID after bootstrap (atomic=%s)', async (atomic) => {
    const runWrangler = runner({
      ...(atomic
        ? {}
        : {
            status: { stdout: '', stderr: 'Worker not found. [code: 10007]', status: 1 },
            upload: { stdout: '', stderr: LOCAL_DURABLE_MIGRATION_ERROR, status: 1 },
          }),
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://bootstrap.example.workers.dev`),
    });
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'bootstrap',
      atomic,
      requireVersionMetadata: true,
      readinessAttempts: 1,
      message: encodeCloudflareVersionMessage([]),
      fetch: async () => Response.json({ ready: true, versionId: CURRENT }),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: atomic ? 'atomic-readiness-failed' : 'bootstrap-readiness-failed',
      versionId: NEXT,
    });
  });

  it('probes a custom route after first-deployment bootstrap', async () => {
    const triggerConfig = customDomainTriggers('bootstrap.example.com');
    const runWrangler = runner({
      status: { stdout: '', stderr: 'This Worker does not exist. [code: 10007]', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}`),
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'bootstrap-private',
        message: encodeCloudflareVersionMessage([], triggerConfig),
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({
      ok: true,
      previewUrl: 'https://bootstrap.example.com',
      previousVersionId: null,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://bootstrap.example.com/__void/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('stops bootstrap before readiness when its custom domain cannot be published', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'Worker not found. [code: 10007]', status: 1 },
      upload: { stdout: '', stderr: LOCAL_DURABLE_MIGRATION_ERROR, status: 1 },
      bootstrap: ok(`Current Version ID: ${NEXT}`),
      triggers: { stdout: '', stderr: 'Domain publication failed.', status: 1 },
    });
    const fetcher = vi.fn();
    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'first-private',
      message: encodeCloudflareVersionMessage([], customDomainTriggers('app.example.com')),
      fetch: fetcher,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'triggers-failed',
      versionId: NEXT,
      activeVersionId: NEXT,
      rollback: 'unavailable',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'repairs a concurrent bootstrap owner (during readiness=%s)',
    async (duringReadiness) => {
      const concurrentConfig = customDomainTriggers('other.example.com');
      const base = runner({
        status: { stdout: '', stderr: 'Worker not found. [code: 10007]', status: 1 },
        upload: { stdout: '', stderr: LOCAL_DURABLE_MIGRATION_ERROR, status: 1 },
        bootstrap: ok(`Current Version ID: ${NEXT}`),
      });
      let bootstrapped = false;
      let superseded = false;
      const published: Array<unknown> = [];
      const runWrangler = operationFixture((args: Array<string>) => {
        if (superseded && args[0] === 'deployments') {
          return ok(JSON.stringify({ versions: [{ version_id: CONCURRENT, percentage: 100 }] }));
        }
        if (bootstrapped && args[0] === 'versions' && args[1] === 'list') {
          return ok(
            JSON.stringify([
              {
                id: CONCURRENT,
                annotations: {
                  'workers/message': encodeCloudflareVersionMessage([], concurrentConfig),
                },
              },
            ]),
          );
        }
        if (args[0] === 'triggers') {
          published.push(readConfigArg(args));
        }
        const result = base(args);
        if (args[0] === 'deploy') {
          bootstrapped = true;
          superseded = !duringReadiness;
        }
        return result;
      });
      const fetcher = vi.fn(async () => {
        superseded = true;
        return Response.json({ ready: true });
      });
      const result = await activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-private',
        message: encodeCloudflareVersionMessage([], {
          ...concurrentConfig,
          routes: [{ pattern: 'superseded.example.com', custom_domain: true }],
        }),
        fetch: fetcher,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'deployment-changed',
        activeVersionId: CONCURRENT,
        rollback: 'not-needed',
        triggerRepair: 'succeeded',
      });
      expect(published).toEqual([
        ...(duringReadiness
          ? [
              expect.objectContaining({
                routes: [{ pattern: 'superseded.example.com', custom_domain: true }],
                workers_dev: false,
                preview_urls: false,
              }),
            ]
          : []),
        expect.objectContaining({
          routes: concurrentConfig.routes,
          workers_dev: false,
          preview_urls: false,
        }),
      ]);
      expect(fetcher).toHaveBeenCalledTimes(duringReadiness ? 1 : 0);
    },
  );

  it('bootstraps first-deploy Durable Object migrations after Cloudflare error 10211', async () => {
    const base = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      upload: { stdout: '', stderr: '', status: 1, errorCode: 10211 },
      bootstrap: ok(
        `Current Version ID: ${NEXT}\nVersion Preview URL: https://2e209d56-first.example.workers.dev`,
      ),
    });
    const secretPayloads: Array<unknown> = [];
    const secretPaths: Array<string> = [];
    const runWrangler = operationFixture((args: Array<string>) => {
      if (
        (args[0] === 'deploy' || (args[0] === 'versions' && args[1] === 'upload')) &&
        args.includes('--secrets-file')
      ) {
        const path = args[args.indexOf('--secrets-file') + 1]!;
        secretPaths.push(path);
        secretPayloads.push(JSON.parse(readFileSync(path, 'utf8')));
      }
      return base(args);
    });
    const fetcher = vi.fn(async () => Response.json({ ready: true }));

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        configPath: '/app/wrangler.jsonc',
        assetsDirectoryOverride: '/app/.void/deploy/cloudflare/assets',
        message: encodeCloudflareVersionMessage(['0001_init.sql']),
        candidateSecrets: { API_TOKEN: 'first-secret' },
        fetch: fetcher,
      }),
    ).resolves.toEqual({
      ok: true,
      versionId: NEXT,
      previewUrl: 'https://first.example.workers.dev',
      previousVersionId: null,
      workersDevSubdomain: 'example',
    });
    expect(runWrangler.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['deployments', 'status'],
      ['versions', 'upload'],
      ['deployments', 'status'],
      ['deploy', '-c'],
      ['deployments', 'status'],
      ['deployments', 'status'],
      ['triggers', 'deploy'],
      ['deployments', 'status'],
      ['deployments', 'status'],
    ]);
    const deployArgs = runWrangler.mock.calls.find(([args]) => args[0] === 'deploy')![0];
    expect(deployArgs).toContain('--assets');
    expect(deployArgs).toContain('/app/.void/deploy/cloudflare/assets');
    expect(secretPayloads).toEqual([{ API_TOKEN: 'first-secret' }, { API_TOKEN: 'first-secret' }]);
    expect(new Set(secretPaths).size).toBe(1);
    expect(secretPaths.every((path) => !existsSync(path))).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      'https://first.example.workers.dev/__void/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports Access blocking the already-active first Worker bootstrap', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'The Worker first has no deployments.', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => new Response('error code: 1050', { status: 403 }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'bootstrap-readiness-access-denied',
      rollback: 'unavailable',
    });
  });

  it('bootstraps a Worker that the Versions API cannot create', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'This Worker does not exist. [code: 10007]', status: 1 },
      upload: {
        stdout: '',
        stderr:
          'You cannot upload a new version of a Worker that does not yet exist. Please run the `deploy` command first.',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-static',
        message: encodeCloudflareVersionMessage([]),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: null });
    expect(runWrangler.mock.calls.map(([args]) => args[0])).toEqual([
      'deployments',
      'versions',
      'deployments',
      'deploy',
      'deployments',
      'deployments',
      'triggers',
      'deployments',
      'deployments',
    ]);
  });

  it('never falls back to non-versioned deployment for an existing Worker', async () => {
    const runWrangler = runner({
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'existing',
        message: encodeCloudflareVersionMessage(['0002_state.sql']),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      status: 1,
      cloudflareErrorCode: 10211,
      diagnostic: 'Durable Object migrations require deploy. [code: 10211]',
    });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false);
  });

  it('returns the validation diagnostic when uploading an existing Worker fails', async () => {
    const runWrangler = runner({
      upload: {
        stdout: 'Your Worker has access to these bindings:\nenv.PRIVATE_VALUE: "do-not-echo"',
        stderr:
          '\u001b[31m✘ [ERROR]\u001b[0m A request to the Cloudflare API failed.\n\n  Uncaught TypeError: Cannot read properties of undefined (reading "fetch")\n    at index.js:42:1\n  [code: 10021]\n',
        status: 1,
      },
    });

    const result = await activateCloudflareVersion({
      runWrangler,
      verifyUploader: () => true,
      workerName: 'existing',
      message: encodeCloudflareVersionMessage([]),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'upload-failed',
      cloudflareErrorCode: 10021,
      diagnostic: expect.stringContaining('Uncaught TypeError:'),
    });
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false);
    expect(runWrangler.mock.calls.some(([args]) => args.includes('--yes'))).toBe(false);
  });

  it('returns the validation diagnostic when a first-deployment bootstrap fails', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'This Worker does not exist. [code: 10007]', status: 1 },
      upload: {
        stdout: '',
        stderr: 'You cannot upload a new version of a Worker that does not yet exist.',
        status: 1,
      },
      bootstrap: {
        stdout: '',
        stderr: '✘ [ERROR] Script startup exceeded CPU time limit. [code: 10021]',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'new-worker',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'bootstrap-failed',
      cloudflareErrorCode: 10021,
      diagnostic: 'Script startup exceeded CPU time limit. [code: 10021]',
    });
  });

  it('classifies a Containers entitlement failure during version upload', async () => {
    const runWrangler = runner({
      upload: {
        stdout: '',
        stderr:
          'Authentication error [GET https://api.cloudflare.com/client/v4/accounts/acc/containers/me] status: 403',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'sandbox-app',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      status: 1,
      containersUnavailable: true,
      diagnostic:
        'Authentication error [GET https://api.cloudflare.com/client/v4/accounts/acc/containers/me] status: 403',
    });
  });

  it('classifies a Containers entitlement failure during first-deploy bootstrap', async () => {
    const runWrangler = runner({
      status: { stdout: '', stderr: 'This Worker does not exist. [code: 10007]', status: 1 },
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: {
        stdout: '',
        stderr:
          'Authentication error [GET https://api.cloudflare.com/client/v4/accounts/acc/containers/me] status: 403',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'sandbox-app',
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'bootstrap-failed',
      status: 1,
      containersUnavailable: true,
      diagnostic:
        'Authentication error [GET https://api.cloudflare.com/client/v4/accounts/acc/containers/me] status: 403',
    });
  });

  it('bootstraps over the placeholder version created while provisioning a first secret', async () => {
    const runWrangler = runner({
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-with-secret',
        message: encodeCloudflareVersionMessage(['0001_state.sql']),
        allowFirstDeploymentBootstrap: true,
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: CURRENT });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(true);
  });

  it("recognizes Wrangler's active secret-only draft without same-process provisioning proof", async () => {
    const runWrangler = runner({
      versions: ok(JSON.stringify([secretOnlyDraftVersion()])),
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'first-with-existing-secret',
        message: encodeCloudflareVersionMessage(['0001_state.sql']),
        fetch: async () => Response.json({ ready: true }),
      }),
    ).resolves.toMatchObject({ ok: true, previousVersionId: CURRENT });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(true);
  });

  it('rejects a secret-triggered version that also contains application configuration', async () => {
    const draft = secretOnlyDraftVersion();
    const version = {
      ...draft,
      annotations: {
        ...draft.annotations,
        'workers/message': 'deployed application',
      },
      resources: {
        ...draft.resources,
        bindings: [...draft.resources.bindings, { name: 'PUBLIC_VALUE', type: 'plain_text' }],
        script_runtime: {
          ...draft.resources.script_runtime,
          compatibility_date: '2026-09-01',
        },
      },
    };
    const runWrangler = runner({
      versions: ok(JSON.stringify([version])),
      upload: {
        stdout: '',
        stderr: 'Durable Object migrations require deploy. [code: 10211]',
        status: 1,
      },
    });

    await expect(
      activateCloudflareVersion({
        runWrangler,
        verifyUploader: () => true,
        workerName: 'existing-with-secret',
        message: encodeCloudflareVersionMessage(['0002_state.sql']),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'upload-failed',
      status: 1,
      cloudflareErrorCode: 10211,
      diagnostic: 'Durable Object migrations require deploy. [code: 10211]',
    });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false);
  });

  const firstSecretTriggers = triggersWith({
    preserveRoutes: true,
    preserveWorkersDev: true,
    preservePreviewUrls: true,
  });

  function firstSecretRunner(
    inspection: CloudflareCommandResult,
    upload: CloudflareCommandResult = {
      stdout: '',
      stderr: 'Durable Object migrations require deploy. [code: 10211]',
      status: 1,
    },
  ) {
    const base = runner({
      // Cloudflare's list response has annotations but no resources, unlike versions view.
      versions: ok(
        JSON.stringify([
          { id: CONCURRENT, number: 1, annotations: { 'workers/triggered_by': 'upload' } },
          { id: CURRENT, number: 2, annotations: { 'workers/triggered_by': 'secret' } },
        ]),
      ),
      upload,
      bootstrap: ok(`Current Version ID: ${NEXT}\nhttps://first.example.workers.dev`),
    });
    return operationFixture((args: Array<string>) => {
      if (args[0] === 'versions' && args[1] === 'view') {
        expect(args[2]).toBe(CURRENT);
        return inspection;
      }
      return base(args);
    });
  }

  it.each([{}, { limits: {} }])(
    'passes lifecycle preflight and retries a first secret-only deploy for runtime %j',
    async (limits) => {
      const draft = secretOnlyDraftVersion();
      const runWrangler = firstSecretRunner(
        ok(
          JSON.stringify({
            ...draft,
            resources: {
              ...draft.resources,
              script_runtime: { usage_model: 'standard', ...limits },
            },
          }),
        ),
      );
      const root = mkdtempSync(join(tmpdir(), 'void-secret-lifecycle-retry-'));
      const configPath = join(root, 'wrangler.jsonc');
      writeFileSync(
        configPath,
        JSON.stringify({
          migrations: [{ tag: 'live-v1', new_sqlite_classes: ['VoidLiveStreamDurableObject'] }],
        }),
      );
      const readMigrationTag = vi.fn(async () => null);
      try {
        await assertCloudflareDurableObjectLifecycleSupported({
          runWrangler,
          configPath,
          workerName: 'first-with-existing-secret',
          accountId: 'account',
          apiBaseUrl: 'https://api.cloudflare.test/client/v4',
          readMigrationTag,
        });
        expect(readMigrationTag).toHaveBeenCalledTimes(2);
        expect(
          runWrangler.mock.calls.some(([args]) => args[0] === 'deploy' || args[1] === 'upload'),
        ).toBe(false);
        await expect(
          activateCloudflareVersion({
            runWrangler,
            configPath,
            verifyUploader: () => true,
            verifyInheritedSecrets: true,
            workerName: 'first-with-existing-secret',
            message: encodeCloudflareVersionMessage(['0001_state.sql'], firstSecretTriggers),
            fetch: async () => Response.json({ ready: true }),
          }),
        ).resolves.toMatchObject({ ok: true, previousVersionId: CURRENT });
        expect(runWrangler.mock.calls.some(([args]) => args[1] === 'view')).toBe(true);
        expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    'does not bootstrap an existing app for the local migration error (preserve triggers: %s)',
    async (preserveTriggers) => {
      const runWrangler = runner({
        upload: { stdout: '', stderr: LOCAL_DURABLE_MIGRATION_ERROR, status: 1 },
      });
      await expect(
        activateCloudflareVersion({
          runWrangler,
          workerName: 'existing',
          verifyUploader: () => true,
          preserveTriggers,
          message: encodeCloudflareVersionMessage([]),
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'upload-failed',
        diagnostic: LOCAL_DURABLE_MIGRATION_ERROR,
      });
      expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false);
    },
  );

  it('does not bootstrap a secret-only draft after an unrelated upload failure', async () => {
    const runWrangler = firstSecretRunner(ok(JSON.stringify(secretOnlyDraftVersion())), {
      stdout: '',
      stderr: 'Authentication failed. [code: 10000]',
      status: 1,
    });
    await expect(
      activateCloudflareVersion({
        runWrangler,
        workerName: 'first-with-secret',
        verifyUploader: () => true,
        message: encodeCloudflareVersionMessage([]),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'upload-failed', cloudflareErrorCode: 10000 });
    expect(runWrangler.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false);
  });

  it.each([{ limits: { cpu_ms: 100 } }, { limits: null }, { compatibility_date: '2026-09-01' }])(
    'preserves existing traffic when the secret-triggered version has runtime settings %j',
    async (runtime) => {
      const draft = secretOnlyDraftVersion();
      const runWrangler = firstSecretRunner(
        ok(
          JSON.stringify({
            ...draft,
            resources: {
              ...draft.resources,
              script_runtime: { usage_model: 'standard', ...runtime },
            },
          }),
        ),
      );
      await expect(
        activateCloudflareVersion({
          runWrangler,
          verifyUploader: () => true,
          workerName: 'existing-with-secret',
          message: encodeCloudflareVersionMessage([], firstSecretTriggers),
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'traffic-preservation-unavailable' });
      expect(
        runWrangler.mock.calls.some(([args]) => args[1] === 'upload' || args[0] === 'deploy'),
      ).toBe(false);
    },
  );

  it.each([
    { stdout: '', stderr: 'Permission denied', status: 1 },
    ok('invalid JSON'),
    ok(JSON.stringify({ ...secretOnlyDraftVersion(), id: CONCURRENT })),
  ])(
    'does not bypass traffic preservation when inspection fails or returns another version',
    async (inspection) => {
      const runWrangler = firstSecretRunner(inspection);
      await expect(
        activateCloudflareVersion({
          runWrangler,
          verifyUploader: () => true,
          workerName: 'existing-with-secret',
          message: encodeCloudflareVersionMessage([], firstSecretTriggers),
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'traffic-preservation-unavailable' });
      expect(
        runWrangler.mock.calls.some(([args]) => args[1] === 'upload' || args[0] === 'deploy'),
      ).toBe(false);
    },
  );
});
