import { describe, expect, it, vi } from 'vite-plus/test';
import type { CloudflareCommandResult, CloudflareCommandRunner } from '../../src/execute.ts';
import type { CloudflareOperation } from '../../src/operations.ts';
import {
  cloudflarePreviewNameProblem,
  deleteCloudflarePreview,
  deployCloudflarePreview,
  validateCloudflarePreviewName,
} from '../../src/preview.ts';

const uploaded = {
  previewId: 'prv_1',
  previewName: 'pr-64',
  deploymentId: 'dep_1',
  previewUrl: 'https://pr-64-site.team.workers.dev',
  deploymentUrl: 'https://dep1-site.team.workers.dev',
};

function runner(answer: Partial<CloudflareCommandResult>) {
  const calls: Array<CloudflareOperation> = [];
  const runWrangler: CloudflareCommandRunner = vi.fn((operation: CloudflareOperation) => {
    calls.push(operation);
    return { status: 0, stdout: '', stderr: '', ...answer };
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

describe('validateCloudflarePreviewName', () => {
  it.each(['pr-64', 'a', 'feature-login', '0'])('accepts %s', (name) => {
    expect(validateCloudflarePreviewName(name, 'site')).toBeNull();
  });

  it.each(['', 'PR-64', 'pr_64', 'feature/login', '-pr', 'pr-', '--flag', 'pr 64'])(
    'rejects %j',
    (name) => {
      expect(validateCloudflarePreviewName(name, 'site')).toContain('not a valid preview name');
    },
  );

  it('rejects a name whose workers.dev label would exceed 63 characters', () => {
    expect(validateCloudflarePreviewName('pr-64', 'w'.repeat(58))).toContain('63 characters');
    expect(validateCloudflarePreviewName('pr-64', 'w'.repeat(57))).toBeNull();
  });
});

describe('deployCloudflarePreview', () => {
  it('sends only previews.deploy and returns the stable Preview URL', async () => {
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
    // Production is never read or changed: no versions, deployments, traffic or triggers.
    expect(calls).toEqual([
      {
        type: 'previews.deploy',
        workerName: 'site',
        previewName: 'pr-64',
        configPath: '/app/wrangler.json',
      },
    ]);
  });

  it('rejects an invalid name or a changed uploader before running anything', async () => {
    const { calls, runWrangler } = runner({ data: uploaded });
    expect(
      await deployCloudflarePreview({ ...target, runWrangler, previewName: '--force' }),
    ).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(
      await deployCloudflarePreview({ ...target, runWrangler, verifyUploader: () => false }),
    ).toEqual({ ok: false, reason: 'uploader-changed' });
    expect(calls).toEqual([]);
  });

  it('reports a failed deploy', async () => {
    const { runWrangler } = runner({ status: 1, errors: [{ message: 'Authentication error' }] });
    expect(await deployCloudflarePreview({ ...target, runWrangler })).toMatchObject({
      ok: false,
      reason: 'deploy-failed',
      status: 1,
    });
  });

  it('reports disabled Preview URLs when Cloudflare returns none', async () => {
    const { previewUrl: _, ...withoutUrl } = uploaded;
    const { runWrangler } = runner({ data: withoutUrl });
    expect(await deployCloudflarePreview({ ...target, runWrangler })).toEqual({
      ok: false,
      reason: 'preview-urls-disabled',
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
