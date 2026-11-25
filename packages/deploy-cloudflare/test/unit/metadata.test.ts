import { describe, expect, it, vi } from 'vite-plus/test';
import { createCloudflareMetadataRunner } from '../../src/metadata.ts';
import type { CloudflareOperation } from '../../src/operations.ts';

const suffix = { configPath: 'wrangler.json', workerName: 'worker' };
const statusArgs: CloudflareOperation = { type: 'deployments.status', ...suffix };
const capture = { capture: true };
const fallbackResult = { status: 7, stdout: '', stderr: 'fallback result' };
const success = (result: unknown) => Response.json({ success: true, result });
function setup(
  fetcher = vi.fn<typeof fetch>(),
  env: Readonly<Record<string, string | undefined>> = {},
) {
  const runWrangler = vi.fn(async () => fallbackResult);
  const getToken = vi.fn<() => Promise<string | null>>(async () => 'test-session');
  const verifyUploader = vi.fn(() => true);
  const run = createCloudflareMetadataRunner({
    runWrangler,
    getToken,
    verifyUploader,
    fetch: fetcher,
    env,
    accountId: 'account',
    apiBaseUrl: 'https://api.example.com/client/v4/',
    workerName: 'worker',
    configPath: 'wrangler.json',
  });
  return { run, runWrangler, getToken, verifyUploader, fetcher };
}

describe('Cloudflare metadata transport', () => {
  it('reuses authentication but rereads production ownership on every check', async () => {
    const first = { versions: [{ version_id: 'old', percentage: 100 }] };
    const second = { versions: [{ version_id: 'new', percentage: 100 }] };
    const { run, getToken, fetcher, runWrangler } = setup(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(success({ deployments: [first] }))
        .mockResolvedValueOnce(success({ deployments: [second] })),
    );
    expect((await run(statusArgs, capture)).data).toEqual(first);
    expect((await run(statusArgs, capture)).data).toEqual(second);
    expect(getToken).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example.com/client/v4/accounts/account/workers/scripts/worker/deployments',
      expect.objectContaining({
        redirect: 'manual',
        headers: { Authorization: 'Bearer test-session' },
      }),
    );
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('matches oldest-first ordering and the ten-version limit without losing annotations', async () => {
    const versions = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      number: i,
      metadata: { created_on: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` },
      annotations: { 'workers/message': `message-${i}` },
    }));
    const { run, fetcher } = setup(
      vi.fn<typeof fetch>().mockResolvedValue(success({ items: [...versions].reverse() })),
    );
    const result = await run({ type: 'versions.list', ...suffix }, capture);
    expect(result.data).toEqual(versions.slice(-10));
    expect(fetcher.mock.calls[0]?.[0]).toContain('/versions?deployable=true');
  });

  it('preserves version inspection and empty-deployment contracts', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const version = { id, resources: { bindings: [], script: {}, script_runtime: {} } };
    const { run } = setup(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(success(version))
        .mockResolvedValueOnce(success({ deployments: [] })),
    );
    expect((await run({ type: 'versions.view', versionId: id, ...suffix }, capture)).data).toEqual(
      version,
    );
    expect(await run(statusArgs, capture)).toMatchObject({
      status: 1,
      stderr: 'The Worker worker has no deployments.',
    });
  });

  it.each<CloudflareOperation>([
    {
      type: 'versions.view',
      versionId: '11111111-1111-4111-8111-111111111111',
      includeSource: true,
      ...suffix,
    },
    { type: 'versions.upload', ...suffix },
    { type: 'versions.deploy', versions: [], ...suffix },
    { type: 'deployments.status', configPath: 'another.json', workerName: 'worker' },
    { type: 'deployments.status', configPath: 'wrangler.json', workerName: 'other' },
  ])('leaves writes and other targets with the pinned runner: %j', async (operation) => {
    const { run, runWrangler, getToken, fetcher } = setup();
    expect(await run(operation, capture)).toBe(fallbackResult);
    expect(runWrangler).toHaveBeenCalledWith(operation, capture);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    () => new Response('bad json'),
    () => success({ wrong: [] }),
    () => new Response('unavailable', { status: 503 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://other.example/' } }),
    () => Response.json({ success: false, errors: [{ code: 10_007 }] }),
  ])('falls back for unreadable metadata without forwarding redirects', async (response) => {
    const { run, fetcher, runWrangler } = setup(
      vi.fn<typeof fetch>().mockImplementation(async () => response()),
    );
    expect(await run(statusArgs, capture)).toBe(fallbackResult);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(runWrangler).toHaveBeenCalledOnce();
  });

  it('renews the session after an authentication failure', async () => {
    const { run, getToken } = setup(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(success({ deployments: [{ versions: [] }] })),
    );
    await run(statusArgs, capture);
    expect((await run(statusArgs, capture)).status).toBe(0);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('never authenticates or falls back through a changed uploader', async () => {
    const { run, verifyUploader, getToken, runWrangler, fetcher } = setup();
    verifyUploader.mockReturnValue(false);
    expect(await run(statusArgs, capture)).toMatchObject({ status: 1, error: 'uploader-changed' });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('rechecks the uploader before a fallback following a failed API request', async () => {
    const { run, verifyUploader, runWrangler } = setup(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('network')),
    );
    verifyUploader.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await run(statusArgs, capture)).toMatchObject({ error: 'uploader-changed' });
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('keeps unsupported authentication on Wrangler without repeated credential reads', async () => {
    const { run, getToken, fetcher } = setup();
    getToken.mockResolvedValue(null);
    expect(await run(statusArgs, capture)).toBe(fallbackResult);
    expect(await run(statusArgs, capture)).toBe(fallbackResult);
    expect(getToken).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['lower-case HTTPS proxy', { https_proxy: 'http://proxy.test:8080' }],
    ['upper-case HTTPS proxy', { HTTPS_PROXY: 'http://proxy.test:8080' }],
    ['HTTP proxy inherited for HTTPS', { HTTP_PROXY: 'http://proxy.test:8080' }],
    [
      'HTTPS proxy with a matching NO_PROXY',
      { HTTPS_PROXY: 'http://proxy.test', NO_PROXY: 'api.example.com' },
    ],
  ])('uses Wrangler before authentication with a configured %s', async (_name, env) => {
    const { run, runWrangler, getToken, verifyUploader, fetcher } = setup(
      vi.fn<typeof fetch>(),
      env,
    );
    expect(await run(statusArgs, capture)).toBe(fallbackResult);
    expect(verifyUploader).toHaveBeenCalledOnce();
    expect(runWrangler).toHaveBeenCalledOnce();
    expect(getToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the uploader integrity guard on the proxy bypass', async () => {
    const { run, runWrangler, getToken, verifyUploader, fetcher } = setup(vi.fn<typeof fetch>(), {
      HTTPS_PROXY: 'http://proxy.test',
    });
    verifyUploader.mockReturnValue(false);
    expect(await run(statusArgs, capture)).toMatchObject({
      status: 1,
      error: 'uploader-changed',
    });
    expect(runWrangler).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
