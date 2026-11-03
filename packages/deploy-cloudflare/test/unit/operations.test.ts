import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vite-plus/test';
import type { CloudflareCommandResult, CloudflareCommandRunner } from '../../src/execute.ts';
import type { CloudflareOperation } from '../../src/operations.ts';
import { activateCloudflareVersion, encodeCloudflareVersionMessage } from '../../src/version.ts';

const current = '11111111-1111-4111-8111-111111111111';
const next = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';

function setup(
  data: unknown,
  failure?: 'activation' | 'triggers',
  // How Cloudflare answers a deploy of the previous version without force.
  rollback?: 'secret-changed' | 'deployed-elsewhere' | 'error',
) {
  const calls: Array<CloudflareOperation> = [];
  let uploaded = false;
  let triggerFailed = false;
  let versions = [{ version_id: current, percentage: 100 }];
  const runWrangler: CloudflareCommandRunner = vi.fn((operation: CloudflareOperation) => {
    calls.push(operation);
    const ok = (data?: unknown) => ({
      status: 0,
      stdout: 'Provider presentation is not a protocol.',
      stderr: '',
      data,
    });
    switch (operation.type) {
      case 'deployments.status':
        return ok({ versions });
      case 'versions.list':
        return ok([
          {
            id: current,
            number: 1,
            annotations: {
              'workers/message': encodeCloudflareVersionMessage([], {
                workers_dev: true,
                preview_urls: true,
                routes: [],
                crons: ['0 * * * *'],
                queueConsumers: [],
                workflows: [],
              }),
            },
          },
          ...(uploaded ? [{ id: next, number: 2 }] : []),
        ]);
      case 'versions.upload':
        uploaded = true;
        return ok(data);
      case 'versions.deploy':
        if (
          rollback &&
          !operation.bypassDeploymentChecks &&
          operation.versions.length === 1 &&
          operation.versions[0]?.versionId === current
        ) {
          if (rollback === 'error') {
            return { ...ok(), status: 1, errorCode: 10000 };
          }
          if (rollback === 'deployed-elsewhere') {
            versions = [{ version_id: other, percentage: 100 }];
          }
          return { ...ok(), status: 1, errorCode: 10220 };
        }
        if (
          failure === 'activation' &&
          operation.versions.some(
            (version) => version.versionId === next && version.percentage === 100,
          )
        ) {
          return { ...ok(), status: 1 };
        }
        versions = operation.versions.map(({ versionId, percentage }) => ({
          version_id: versionId,
          percentage,
        }));
        return ok();
      case 'triggers.deploy':
        if (failure === 'triggers' && !triggerFailed) {
          triggerFailed = true;
          return { ...ok(), status: 1 };
        }
        return ok();
      default:
        throw new Error(`Unexpected operation ${operation.type}.`);
    }
  });
  return { calls, runWrangler };
}

it('activates structured upload data independently of provider presentation', async () => {
  const { calls, runWrangler } = setup({
    versionId: next,
    previewUrl: 'https://ready.example.workers.dev',
  });
  const result = await activateCloudflareVersion({
    runWrangler,
    workerName: 'site',
    verifyUploader: () => true,
    message: encodeCloudflareVersionMessage([]),
    fetch: async () => Response.json({ ready: true }),
  });
  expect(result).toMatchObject({ ok: true, versionId: next });
  expect(calls.find((operation) => operation.type === 'versions.upload')).toMatchObject({
    type: 'versions.upload',
    workerName: 'site',
    previewAlias: expect.any(String),
  });
  expect(calls.find((operation) => operation.type === 'versions.deploy')).toMatchObject({
    type: 'versions.deploy',
    versions: [{ versionId: next, percentage: 100 }],
  });
  expect(calls.find((operation) => operation.type === 'versions.deploy')).not.toHaveProperty(
    'bypassDeploymentChecks',
  );
});

const recoveries = [
  { failure: 'readiness', preserveTriggers: false, reason: 'readiness-failed' },
  { failure: 'readiness', preserveTriggers: true, reason: 'readiness-failed' },
  { failure: 'activation', preserveTriggers: false, reason: 'activation-failed' },
  { failure: 'activation', preserveTriggers: true, reason: 'activation-failed' },
  { failure: 'triggers', preserveTriggers: false, reason: 'triggers-failed' },
] as const;

async function recover(
  { failure, preserveTriggers }: (typeof recoveries)[number],
  rollback?: Parameters<typeof setup>[2],
) {
  const directory = mkdtempSync(join(tmpdir(), 'void-rollback-checks-'));
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(configPath, JSON.stringify({ name: 'site' }));
  try {
    const { calls, runWrangler } = setup(
      { versionId: next },
      failure === 'readiness' ? undefined : failure,
      rollback,
    );
    const result = await activateCloudflareVersion({
      runWrangler,
      configPath,
      workerName: 'site',
      workersDevSubdomain: 'example',
      preserveTriggers,
      verifyUploader: () => true,
      message: encodeCloudflareVersionMessage([]),
      readinessAttempts: 1,
      fetch: async () =>
        failure === 'readiness'
          ? new Response('not ready', { status: 503 })
          : Response.json({ ready: true }),
    });
    const rollbacks = calls.filter(
      (operation) =>
        operation.type === 'versions.deploy' &&
        operation.versions.length === 1 &&
        operation.versions[0]?.versionId === current,
    );
    return { calls, result, rollbacks };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each(recoveries)(
  'restores $failure failures without force when Cloudflare accepts it (preserveTriggers=$preserveTriggers)',
  async (recovery) => {
    const { calls, result, rollbacks } = await recover(recovery);
    expect(result).toMatchObject({ ok: false, reason: recovery.reason, rollback: 'succeeded' });
    expect(result).not.toHaveProperty('restoredOlderSecrets');
    expect(rollbacks).toHaveLength(1);
    for (const operation of calls) {
      expect(operation).not.toHaveProperty('bypassDeploymentChecks');
    }
  },
);

it.each(recoveries)(
  'forces the $failure restore after Cloudflare refuses an old secret version (preserveTriggers=$preserveTriggers)',
  async (recovery) => {
    const { calls, result, rollbacks } = await recover(recovery, 'secret-changed');
    expect(result).toMatchObject({
      ok: false,
      reason: recovery.reason,
      rollback: 'succeeded',
      restoredOlderSecrets: true,
    });
    expect(rollbacks).toEqual([
      expect.not.objectContaining({ bypassDeploymentChecks: true }),
      expect.objectContaining({ bypassDeploymentChecks: true }),
    ]);
    // Void checks that it still owns traffic between the refusal and the forced retry.
    const refused = calls.indexOf(rollbacks[0]!);
    expect(
      calls.slice(refused, calls.indexOf(rollbacks[1]!)).map((operation) => operation.type),
    ).toContain('deployments.status');
    expect(
      calls.filter(
        (operation) => operation.type === 'versions.deploy' && operation.bypassDeploymentChecks,
      ),
    ).toEqual([rollbacks[1]]);
  },
);

it('does not force a restore after someone else deploys', async () => {
  const { result, rollbacks } = await recover(recoveries[0], 'deployed-elsewhere');
  expect(result).toMatchObject({ ok: false, reason: 'readiness-failed', rollback: 'unsafe' });
  expect(result).not.toHaveProperty('restoredOlderSecrets');
  expect(rollbacks).toHaveLength(1);
  expect(rollbacks[0]).not.toHaveProperty('bypassDeploymentChecks');
});

it('does not force a restore that failed for another reason', async () => {
  const { result, rollbacks } = await recover(recoveries[0], 'error');
  expect(result).toMatchObject({ ok: false, reason: 'readiness-failed', rollback: 'failed' });
  expect(result).not.toHaveProperty('restoredOlderSecrets');
  expect(rollbacks).toHaveLength(1);
  expect(rollbacks[0]).not.toHaveProperty('bypassDeploymentChecks');
});

it('rejects missing structured upload identity before activation', async () => {
  const { calls, runWrangler } = setup({ unrelated: 'value' });
  const result = await activateCloudflareVersion({
    runWrangler,
    workerName: 'site',
    verifyUploader: () => true,
    message: encodeCloudflareVersionMessage([]),
  });
  expect(result).toEqual({ ok: false, reason: 'upload-output-invalid' });
  expect(calls.some((operation) => operation.type === 'versions.deploy')).toBe(false);
});

const interrupted: Array<Partial<CloudflareCommandResult>> = [
  { signal: 'SIGTERM' },
  { error: 'provider process failed' },
  { status: Number.NaN },
];

it.each(interrupted)(
  'does not declare an interrupted deployment probe absent despite its provider code: %j',
  async (provenance) => {
    const { calls, runWrangler } = setup({ versionId: next });
    const result = await activateCloudflareVersion({
      runWrangler: (operation, options) =>
        operation.type === 'deployments.status'
          ? {
              status: 1,
              stdout: '',
              stderr: '',
              failure: 'not-found',
              errorCode: 10007,
              ...provenance,
            }
          : runWrangler(operation, options),
      workerName: 'site',
      verifyUploader: () => true,
      message: encodeCloudflareVersionMessage([]),
    });
    expect(result).toMatchObject({ ok: false, reason: 'status-failed' });
    expect(calls).toEqual([]);
  },
);

it.each(interrupted)(
  'does not treat interrupted version history as empty despite its provider code: %j',
  async (provenance) => {
    const { calls, runWrangler } = setup({ versionId: next });
    const result = await activateCloudflareVersion({
      runWrangler: (operation, options) =>
        operation.type === 'versions.list'
          ? {
              status: 1,
              stdout: '',
              stderr: '',
              failure: 'not-found',
              errorCode: 10007,
              ...provenance,
            }
          : runWrangler(operation, options),
      workerName: 'site',
      verifyUploader: () => true,
      verifyInheritedSecrets: true,
      message: encodeCloudflareVersionMessage([]),
    });
    expect(result).toMatchObject({ ok: false, reason: 'inheritance-source-unavailable' });
    expect(calls.some((operation) => operation.type === 'versions.upload')).toBe(false);
  },
);

it.each([10007, 10211])(
  'does not bootstrap an interrupted upload despite provider code %s',
  async (errorCode) => {
    for (const provenance of interrupted) {
      const { calls, runWrangler } = setup({ versionId: next });
      const result = await activateCloudflareVersion({
        runWrangler: (operation, options) =>
          operation.type === 'versions.upload'
            ? {
                status: 1,
                stdout: '',
                stderr: '',
                errorCode,
                failure: errorCode === 10007 ? 'not-found' : 'durable-migration',
                ...provenance,
              }
            : runWrangler(operation, options),
        workerName: 'site',
        verifyUploader: () => true,
        allowFirstDeploymentBootstrap: true,
        message: encodeCloudflareVersionMessage([]),
      });
      expect(result).toMatchObject({ ok: false, reason: 'upload-failed' });
      expect(calls.some((operation) => operation.type === 'worker.deploy')).toBe(false);
    }
  },
);
