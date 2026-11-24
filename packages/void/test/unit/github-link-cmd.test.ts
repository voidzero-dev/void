import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformApiError } from '../../src/cli/client.ts';
import type { PlatformClient } from '../../src/cli/client.ts';
import { runGithubLink } from '../../src/cli/github-cmd.ts';
import { browserCallback, throwOnProcessExit } from '../helpers/github-cli.ts';

// Keep openBrowser from launching a real browser.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

type FakeClient = Pick<PlatformClient, 'getGithubLinkUrl' | 'completeGithubLink'>;

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = throwOnProcessExit();
});

afterEach(() => {
  exitSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** Runs runGithubLink and sends the callback redirect that `callbackQuery` builds. */
function drive(opts: {
  completeGithubLink: FakeClient['completeGithubLink'];
  callbackQuery: (callbackUrl: URL) => URL;
}): Promise<void> {
  const callback = browserCallback(opts.callbackQuery);
  const client: FakeClient = {
    getGithubLinkUrl: callback.authUrl,
    completeGithubLink: opts.completeGithubLink,
  };
  return callback.settle(runGithubLink(client as unknown as PlatformClient));
}

describe('runGithubLink', () => {
  it('completes the link on a successful callback (status: linked)', async () => {
    const completeGithubLink = vi.fn(async () => ({ status: 'linked' as const }));

    await drive({
      completeGithubLink,
      callbackQuery: (cb) => {
        const hit = new URL(cb); // already carries the command's state
        hit.searchParams.set('link_code', 'lc-123');
        return hit;
      },
    });

    expect(completeGithubLink).toHaveBeenCalledTimes(1);
    expect(completeGithubLink).toHaveBeenCalledWith('lc-123', expect.any(String));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits(1) on a 409 github_identity_conflict', async () => {
    const completeGithubLink = vi.fn(async () => {
      throw new PlatformApiError(
        'Failed to complete GitHub link',
        409,
        JSON.stringify({ error: 'github_identity_conflict' }),
      );
    });

    await expect(
      drive({
        completeGithubLink,
        callbackQuery: (cb) => {
          const hit = new URL(cb);
          hit.searchParams.set('link_code', 'lc-409');
          return hit;
        },
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits(1) with a distinct message on a 409 github_already_linked', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const completeGithubLink = vi.fn(async () => {
      throw new PlatformApiError(
        'Failed to complete GitHub link',
        409,
        JSON.stringify({ error: 'github_already_linked' }),
      );
    });

    await expect(
      drive({
        completeGithubLink,
        callbackQuery: (cb) => {
          const hit = new URL(cb);
          hit.searchParams.set('link_code', 'lc-already');
          return hit;
        },
      }),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The new code maps to the "your account, different GitHub" message —
    // distinct from the other-user github_identity_conflict wording.
    expect(errorSpy).toHaveBeenCalledWith(
      'Your Void account is already linked to a different GitHub account.',
    );
    errorSpy.mockRestore();
  });

  it('throws when the callback returns no link code', async () => {
    const completeGithubLink = vi.fn(async () => ({ status: 'linked' as const }));

    await expect(
      drive({
        completeGithubLink,
        // valid state, but no link_code in the query
        callbackQuery: (cb) => new URL(cb),
      }),
    ).rejects.toThrow('did not return a link code');

    expect(completeGithubLink).not.toHaveBeenCalled();
  });

  it('re-throws non-conflict PlatformApiErrors', async () => {
    const completeGithubLink = vi.fn(async () => {
      throw new PlatformApiError('Failed to complete GitHub link', 500, 'boom');
    });

    await expect(
      drive({
        completeGithubLink,
        callbackQuery: (cb) => {
          const hit = new URL(cb);
          hit.searchParams.set('link_code', 'lc-500');
          return hit;
        },
      }),
    ).rejects.toMatchObject({ name: 'PlatformApiError', status: 500 });

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
