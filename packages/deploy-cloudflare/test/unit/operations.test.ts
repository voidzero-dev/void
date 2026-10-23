import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vite-plus/test';
import type { CloudflareCommandResult, CloudflareCommandRunner } from '../../src/execute.ts';
import type { CloudflareOperation } from '../../src/operations.ts';
import { activateCloudflareVersion, encodeCloudflareVersionMessage } from '../../src/version.ts';

const current = '11111111-1111-4111-8111-111111111111';
const next = '22222222-2222-4222-8222-222222222222';

function setup(data: unknown, failure?: 'activation' | 'triggers') {
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

it.each([
  { failure: 'readiness', preserveTriggers: false, reason: 'readiness-failed' },
  { failure: 'readiness', preserveTriggers: true, reason: 'readiness-failed' },
  { failure: 'activation', preserveTriggers: false, reason: 'activation-failed' },
  { failure: 'activation', preserveTriggers: true, reason: 'activation-failed' },
  { failure: 'triggers', preserveTriggers: false, reason: 'triggers-failed' },
] as const)(
  'bypasses deployment checks only for automatic $failure recovery with preserveTriggers=$preserveTriggers',
  async ({ failure, preserveTriggers, reason }) => {
    const directory = mkdtempSync(join(tmpdir(), 'void-rollback-checks-'));
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ name: 'site' }));
    try {
      const { calls, runWrangler } = setup(
        { versionId: next },
        failure === 'readiness' ? undefined : failure,
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
      expect(result).toMatchObject({ ok: false, reason, rollback: 'succeeded' });
      const deployments = calls.filter((operation) => operation.type === 'versions.deploy');
      expect(deployments.at(-1)).toMatchObject({
        versions: [{ versionId: current, percentage: 100 }],
        bypassDeploymentChecks: true,
      });
      for (const operation of deployments.slice(0, -1)) {
        expect(operation).not.toHaveProperty('bypassDeploymentChecks');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

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
