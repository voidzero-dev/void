import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareCommandResult, CloudflareOperation } from '@void/deploy-cloudflare';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { runCloudflarePreviewDelete } from '../../src/cli/cloudflare-preview.ts';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';

const output = await import('../../src/cli/output.ts');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-project-preview-'));
  writeFileSync(
    join(root, 'wrangler.json'),
    JSON.stringify({ name: 'my-app', account_id: 'acc123' }),
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function runner(answer: Partial<CloudflareCommandResult>) {
  const calls: Array<CloudflareOperation> = [];
  const run = (operation: CloudflareOperation) => {
    calls.push(operation);
    return { status: 0, stdout: '', stderr: '', ...answer };
  };
  return { calls, run };
}

it('deletes the preview of the configured Worker', async () => {
  const success = vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
  const { calls, run } = runner({});
  await runCloudflarePreviewDelete(root, { name: 'pr-64' }, run);
  expect(calls).toMatchObject([
    { type: 'previews.delete', workerName: 'my-app', previewName: 'pr-64' },
  ]);
  expect(success).toHaveBeenCalledWith(
    'Deleted preview pr-64 of Worker my-app. Production is unchanged.',
  );
});

it('succeeds when the preview does not exist', async () => {
  const info = vi.spyOn(log, 'info').mockImplementation(() => {});
  const { run } = runner({ status: 1, errorCode: 10_025, stderr: 'Not found [code: 10025]' });
  await runCloudflarePreviewDelete(root, { name: 'pr-64' }, run);
  expect(info).toHaveBeenCalledWith(
    'Preview pr-64 does not exist on Worker my-app. Nothing to delete.',
  );
});

it.each([
  [
    { status: 1, errorCode: 10_007 },
    'project: Worker "my-app" was not found in Cloudflare account acc123. Nothing was deleted.',
  ],
  [
    { status: 1, errorCode: 10_000, stderr: 'Authentication error' },
    'project: Cloudflare could not delete preview "pr-64" of Worker "my-app".\nAuthentication error',
  ],
])('fails on %j', async (answer, message) => {
  const { run } = runner(answer);
  await expect(runCloudflarePreviewDelete(root, { name: 'pr-64' }, run)).rejects.toThrow(message);
});

it('refuses an invalid name before reading the config', async () => {
  const { calls, run } = runner({});
  await expect(runCloudflarePreviewDelete(root, { name: 'PR_64' }, run)).rejects.toThrow(
    'project: "PR_64" is not a valid preview name: must start with a lowercase letter.',
  );
  expect(calls).toEqual([]);
});

it('refuses a project that is not deployed to Cloudflare without --platform cloudflare', async () => {
  await expect(
    runProjectCommand(root, { subcommand: 'preview', action: 'delete', name: 'pr-64' }),
  ).rejects.toThrow(
    'project: Previews from `void deploy --preview` exist only for direct Cloudflare deploys. Add --platform cloudflare.',
  );
});
