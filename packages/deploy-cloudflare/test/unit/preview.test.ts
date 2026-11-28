import { describe, expect, it, vi } from 'vite-plus/test';
import type { CloudflareCommandResult, CloudflareCommandRunner } from '../../src/execute.ts';
import type { CloudflareOperation } from '../../src/operations.ts';
import {
  cloudflarePreviewNameProblem,
  deleteCloudflarePreview,
  deployCloudflarePreview,
  previewStaticWorkerConfig,
} from '../../src/preview.ts';

const uploaded = {
  previewId: 'prv_1',
  previewName: 'pr-64',
  deploymentId: 'dep_1',
  previewUrl: 'https://pr-64-site.team.workers.dev',
  deploymentUrl: 'https://dep1-site.team.workers.dev',
};

/** Answer each operation type on its own; the Worker exists unless `status` says otherwise. */
function runner(
  answer: Partial<CloudflareCommandResult>,
  status: Partial<CloudflareCommandResult> = {},
) {
  const calls: Array<CloudflareOperation> = [];
  const runWrangler: CloudflareCommandRunner = vi.fn((operation: CloudflareOperation) => {
    calls.push(operation);
    return {
      status: 0,
      stdout: '',
      stderr: '',
      ...(operation.type === 'deployments.status' ? status : answer),
    };
  });
  return { calls, runWrangler };
}

const target = { workerName: 'site', previewName: 'pr-64', verifyUploader: () => true };

describe('cloudflarePreviewNameProblem', () => {
  it.each(['pr-64', 'a', 'feature-login', 'a'.repeat(63)])('accepts %s', (name) => {
    expect(cloudflarePreviewNameProblem(name)).toBeUndefined();
  });

  it.each([
    ['', 'must be 1 to 63 characters'],
    ['a'.repeat(64), 'must be 1 to 63 characters'],
    ['1a', 'must start with a lowercase letter'],
    ['-a', 'must start with a lowercase letter'],
    ['A', 'must start with a lowercase letter'],
    ['a_b', 'may use only lowercase letters, digits and hyphens'],
    ['a-', 'must end with a letter or digit'],
    ['a--b', 'cannot have two hyphens in a row'],
  ])('refuses %j', (name, problem) => {
    expect(cloudflarePreviewNameProblem(name)).toBe(problem);
  });
});

describe('previewStaticWorkerConfig', () => {
  it('keeps only the allow-listed keys', () => {
    expect(
      previewStaticWorkerConfig({
        name: 'site',
        account_id: 'acc',
        compatibility_date: '2026-01-01',
        compatibility_flags: ['nodejs_compat'],
        assets: { html_handling: 'auto-trailing-slash' },
        observability: { enabled: true },
        version_metadata: { binding: 'CF_VERSION_METADATA' },
        kv_namespaces: [{ binding: 'KV', id: 'kv' }],
        d1_databases: [{ binding: 'DB', database_id: 'db' }],
        vars: { SECRET_LOOKING: 'x' },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
        triggers: { crons: ['* * * * *'] },
        routes: ['example.com/*'],
        preview_urls: true,
      }),
    ).toEqual({
      name: 'site',
      account_id: 'acc',
      compatibility_date: '2026-01-01',
      compatibility_flags: ['nodejs_compat'],
      assets: { html_handling: 'auto-trailing-slash' },
      observability: { enabled: true },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    });
  });
});

describe('deployCloudflarePreview', () => {
  it('checks the Worker, then deploys the Preview and returns its URL', async () => {
    const { calls, runWrangler } = runner({ data: uploaded });
    expect(
      await deployCloudflarePreview({ ...target, runWrangler, configPath: '/app/wrangler.json' }),
    ).toEqual({
      ok: true,
      previewId: 'prv_1',
      deploymentId: 'dep_1',
      previewUrl: 'https://pr-64-site.team.workers.dev',
      deploymentUrl: 'https://dep1-site.team.workers.dev',
    });
    // Production is never changed: no versions, traffic or triggers.
    expect(calls).toEqual([
      { type: 'deployments.status', workerName: 'site', configPath: '/app/wrangler.json' },
      {
        type: 'previews.deploy',
        workerName: 'site',
        previewName: 'pr-64',
        configPath: '/app/wrangler.json',
      },
    ]);
  });

  it.each([
    [
      { status: 1, errorCode: 10_007 },
      { ok: false, reason: 'worker-not-found' },
    ],
    [
      { status: 1, failure: 'not-found' as const },
      { ok: false, reason: 'worker-not-found' },
    ],
    [
      { status: 1, stderr: 'Authentication error' },
      {
        ok: false,
        reason: 'worker-check-failed',
        status: 1,
        diagnostic: 'Authentication error',
      },
    ],
  ])('uploads nothing when the Worker check gives %j', async (status, expected) => {
    const { calls, runWrangler } = runner({ data: uploaded }, status);
    expect(await deployCloudflarePreview({ ...target, runWrangler })).toEqual(expected);
    expect(calls.map((call) => call.type)).toEqual(['deployments.status']);
  });

  it('uploads nothing when the uploader changed', async () => {
    const { calls, runWrangler } = runner({ data: uploaded });
    expect(
      await deployCloudflarePreview({ ...target, runWrangler, verifyUploader: () => false }),
    ).toEqual({ ok: false, reason: 'uploader-changed' });
    expect(calls.map((call) => call.type)).toEqual(['deployments.status']);
  });

  it('reports a failed deploy', async () => {
    const { runWrangler } = runner({ status: 1, stderr: 'Authentication error' });
    expect(await deployCloudflarePreview({ ...target, runWrangler })).toEqual({
      ok: false,
      reason: 'deploy-failed',
      status: 1,
      diagnostic: 'Authentication error',
    });
  });

  it('reports disabled Preview URLs with the deployment Cloudflare created', async () => {
    const { previewUrl: _, ...withoutUrl } = uploaded;
    const { runWrangler } = runner({ data: withoutUrl });
    expect(await deployCloudflarePreview({ ...target, runWrangler })).toEqual({
      ok: false,
      reason: 'preview-urls-disabled',
      deploymentId: 'dep_1',
    });
  });

  it('returns a null deployment URL when Cloudflare gives none', async () => {
    const { deploymentUrl: _, ...withoutUrl } = uploaded;
    const { runWrangler } = runner({ data: withoutUrl });
    expect(await deployCloudflarePreview({ ...target, runWrangler })).toMatchObject({
      ok: true,
      deploymentUrl: null,
    });
  });

  it.each([
    { ...uploaded, previewName: 'pr-65' },
    { ...uploaded, previewUrl: 'http://pr-64-site.team.workers.dev' },
    { ...uploaded, deploymentId: '' },
    undefined,
  ])('rejects an unreadable or foreign Preview record %#', async (data) => {
    const { runWrangler } = runner({ data });
    expect(await deployCloudflarePreview({ ...target, runWrangler })).toEqual({
      ok: false,
      reason: 'output-invalid',
    });
  });
});

describe('deleteCloudflarePreview', () => {
  const deleteTarget = { workerName: 'site', previewName: 'pr-64' };

  it('deletes the named Preview of the Worker', async () => {
    const { calls, runWrangler } = runner({});
    expect(await deleteCloudflarePreview({ ...deleteTarget, runWrangler })).toEqual({
      ok: true,
      deleted: true,
    });
    expect(calls).toEqual([{ type: 'previews.delete', workerName: 'site', previewName: 'pr-64' }]);
  });

  // 10025 is "Preview not found"; 10007 and not-found mean the Worker itself is missing.
  it.each([
    [
      { status: 1, errorCode: 10_025 },
      { ok: true, deleted: false },
    ],
    [
      { status: 1, errorCode: 10_007 },
      { ok: false, reason: 'worker-not-found' },
    ],
    [
      { status: 1, failure: 'not-found' as const },
      { ok: false, reason: 'worker-not-found' },
    ],
    [
      { status: 1, errorCode: 10_000, stderr: 'Authentication error' },
      { ok: false, reason: 'delete-failed', status: 1, diagnostic: 'Authentication error' },
    ],
  ])('maps %j', async (answer, expected) => {
    const { runWrangler } = runner(answer);
    expect(await deleteCloudflarePreview({ ...deleteTarget, runWrangler })).toEqual(expected);
  });
});
