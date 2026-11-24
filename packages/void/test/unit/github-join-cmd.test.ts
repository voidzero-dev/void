import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformApiError } from '../../src/cli/client.ts';
import type { PlatformClient } from '../../src/cli/client.ts';
import { runGithubJoin } from '../../src/cli/github-cmd.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as output from '../../src/cli/output.ts';
import { browserCallback, throwOnProcessExit } from '../helpers/github-cli.ts';

// Keep openBrowser from launching a real browser.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

type FakeClient = Pick<PlatformClient, 'getGithubJoinUrl' | 'completeGithubJoin'>;

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = throwOnProcessExit();
});

afterEach(() => {
  exitSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** Runs runGithubJoin and sends the callback redirect that `callbackQuery` builds. */
function drive(opts: {
  completeGithubJoin: FakeClient['completeGithubJoin'];
  callbackQuery: (callbackUrl: URL) => URL;
}): Promise<void> {
  const callback = browserCallback(opts.callbackQuery);
  const client: FakeClient = {
    getGithubJoinUrl: callback.authUrl,
    completeGithubJoin: opts.completeGithubJoin,
  };
  return callback.settle(runGithubJoin(client as unknown as PlatformClient));
}

describe('runGithubJoin', () => {
  it('completes the join on a successful callback (count > 0, plural)', async () => {
    const successSpy = vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
    const messageSpy = vi.spyOn(log, 'message').mockImplementation(() => {});
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 2 }));

    await drive({
      completeGithubJoin,
      callbackQuery: (cb) => {
        const hit = new URL(cb); // already carries the command's state
        hit.searchParams.set('join_code', 'jc-123');
        return hit;
      },
    });

    expect(completeGithubJoin).toHaveBeenCalledTimes(1);
    expect(completeGithubJoin).toHaveBeenCalledWith('jc-123', expect.any(String));
    expect(successSpy).toHaveBeenCalledWith('Joined 2 installations.');
    expect(messageSpy).toHaveBeenCalledWith(
      'Run `void github installations` to see them, then `void github connect`.',
    );
    expect(exitSpy).not.toHaveBeenCalled();

    successSpy.mockRestore();
    messageSpy.mockRestore();
  });

  it('uses the singular form when exactly one installation is joined', async () => {
    const successSpy = vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 1 }));

    await drive({
      completeGithubJoin,
      callbackQuery: (cb) => {
        const hit = new URL(cb);
        hit.searchParams.set('join_code', 'jc-one');
        return hit;
      },
    });

    expect(successSpy).toHaveBeenCalledWith('Joined 1 installation.');
    expect(exitSpy).not.toHaveBeenCalled();

    successSpy.mockRestore();
  });

  it('reports the no-op path when count === 0', async () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    const successSpy = vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 0 }));

    await drive({
      completeGithubJoin,
      callbackQuery: (cb) => {
        const hit = new URL(cb);
        hit.searchParams.set('join_code', 'jc-zero');
        return hit;
      },
    });

    expect(completeGithubJoin).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('No new installations to join.');
    expect(successSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    infoSpy.mockRestore();
    successSpy.mockRestore();
  });

  it('throws when the callback returns no join code', async () => {
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 1 }));

    await expect(
      drive({
        completeGithubJoin,
        // valid state, but no join_code in the query
        callbackQuery: (cb) => new URL(cb),
      }),
    ).rejects.toThrow('did not return a join code');

    expect(completeGithubJoin).not.toHaveBeenCalled();
  });

  it('exits(1) with a friendly message when org sharing is not configured (503)', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    // getGithubJoinUrl (buildAuthUrl) rejects fail-closed; awaitBrowserCallback
    // tears down the localhost server and rejects WITHOUT firing a callback, so
    // no simulated browser redirect is needed here.
    const getGithubJoinUrl = vi.fn(async () => {
      throw new PlatformApiError(
        'Failed to start GitHub join',
        503,
        JSON.stringify({ error: 'github_oauth_not_configured' }),
      );
    });
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined' as const, count: 0 }));
    const client: FakeClient = { getGithubJoinUrl, completeGithubJoin };

    await expect(runGithubJoin(client as unknown as PlatformClient)).rejects.toThrow(
      'process.exit(1)',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Organization installation sharing is not enabled on this Void instance.',
    );
    expect(completeGithubJoin).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('re-throws non-503 PlatformApiErrors', async () => {
    const completeGithubJoin = vi.fn(async () => {
      throw new PlatformApiError('Failed to complete GitHub join', 500, 'boom');
    });

    await expect(
      drive({
        completeGithubJoin,
        callbackQuery: (cb) => {
          const hit = new URL(cb);
          hit.searchParams.set('join_code', 'jc-500');
          return hit;
        },
      }),
    ).rejects.toMatchObject({ name: 'PlatformApiError', status: 500 });

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
