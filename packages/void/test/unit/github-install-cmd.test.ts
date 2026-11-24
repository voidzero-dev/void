import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { MockInstance } from 'vite-plus/test';
import { PlatformApiError } from '../../src/cli/client.ts';
import type { PlatformClient } from '../../src/cli/client.ts';
import { runInstall } from '../../src/cli/github-cmd.ts';
import { throwOnProcessExit } from '../helpers/github-cli.ts';

// Keep openBrowser from launching a real browser.
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: Array<unknown>) => mockExecFile(...args),
}));

let exitSpy: MockInstance;

function identityRequired(): PlatformApiError {
  return new PlatformApiError(
    'Failed to get GitHub install URL',
    403,
    JSON.stringify({ error: 'github_identity_required' }),
  );
}

beforeEach(() => {
  mockExecFile.mockReset();
  exitSpy = throwOnProcessExit();
});

afterEach(() => {
  exitSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('runInstall', () => {
  it('auto-links then retries getGithubInstallUrl once on a github_identity_required 403', async () => {
    const getGithubInstallUrl = vi
      .fn()
      .mockRejectedValueOnce(identityRequired())
      .mockResolvedValueOnce({ url: 'https://github.com/apps/void/installations/new' });
    const client = { getGithubInstallUrl } as unknown as PlatformClient;
    const linkIdentity = vi.fn(async () => {});

    await runInstall(client, linkIdentity);

    expect(linkIdentity).toHaveBeenCalledTimes(1);
    expect(linkIdentity).toHaveBeenCalledWith(client);
    expect(getGithubInstallUrl).toHaveBeenCalledTimes(2);
    // The install URL was opened in the browser on the success retry.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rethrows a non-identity 403 without auto-linking', async () => {
    const err = new PlatformApiError(
      'Failed to get GitHub install URL',
      403,
      JSON.stringify({ error: 'something_else' }),
    );
    const getGithubInstallUrl = vi.fn().mockRejectedValue(err);
    const client = { getGithubInstallUrl } as unknown as PlatformClient;
    const linkIdentity = vi.fn(async () => {});

    await expect(runInstall(client, linkIdentity)).rejects.toBe(err);

    expect(linkIdentity).not.toHaveBeenCalled();
    expect(getGithubInstallUrl).toHaveBeenCalledTimes(1);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits(1) with actionable guidance when the retry still fails after linking', async () => {
    const getGithubInstallUrl = vi
      .fn()
      .mockRejectedValueOnce(identityRequired())
      .mockRejectedValueOnce(identityRequired());
    const client = { getGithubInstallUrl } as unknown as PlatformClient;
    const linkIdentity = vi.fn(async () => {});

    await expect(runInstall(client, linkIdentity)).rejects.toThrow('process.exit(1)');

    expect(linkIdentity).toHaveBeenCalledTimes(1);
    expect(getGithubInstallUrl).toHaveBeenCalledTimes(2);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rethrows a non-identity error from the post-link retry', async () => {
    const retryErr = new PlatformApiError('Failed to get GitHub install URL', 500, 'boom');
    const getGithubInstallUrl = vi
      .fn()
      .mockRejectedValueOnce(identityRequired())
      .mockRejectedValueOnce(retryErr);
    const client = { getGithubInstallUrl } as unknown as PlatformClient;
    const linkIdentity = vi.fn(async () => {});

    await expect(runInstall(client, linkIdentity)).rejects.toBe(retryErr);

    expect(linkIdentity).toHaveBeenCalledTimes(1);
    expect(getGithubInstallUrl).toHaveBeenCalledTimes(2);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
