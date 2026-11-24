import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { followBuildLogs, isFatalFollowError, runBuildCommand } from '../../src/cli/build-cmd.ts';
import { PlatformApiError, PlatformClient } from '../../src/cli/client.ts';
import type { BuildLogsResponse } from '../../src/cli/client.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';

const registries: Array<string> = [];

afterEach(() => {
  for (const registry of registries.splice(0)) {
    rmSync(registry, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function page(partial: Partial<BuildLogsResponse>): BuildLogsResponse {
  return {
    lines: [],
    lastSeq: 0,
    status: 'building',
    terminal: false,
    logsComplete: null,
    external: null,
    ...partial,
  };
}

function apiError(status: number, body = '{}'): PlatformApiError {
  return new PlatformApiError('build logs', status, body);
}

it.each(['complete', 'failed', 'cancelled'])(
  'uses a success checkmark only for a completed build (%s)',
  async (status) => {
    vi.stubEnv('VOID_TOKEN', 'test-build-logs-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubEnv('VOID_PROJECT', '');
    const registry = mkdtempSync(join(tmpdir(), 'void-build-completion-'));
    registries.push(registry);
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', registry);
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://api.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Test',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });
    vi.spyOn(PlatformClient.prototype, 'listProjects').mockResolvedValue([
      { id: 'project', slug: 'project' } as Awaited<
        ReturnType<PlatformClient['listProjects']>
      >[number],
    ]);
    vi.spyOn(PlatformClient.prototype, 'getBuildLogs').mockResolvedValue(
      page({ terminal: true, logsComplete: true, status }),
    );
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    await runBuildCommand(process.cwd(), {
      subcommand: 'logs',
      buildId: 'build',
      projectName: 'project',
      follow: true,
    });
    const plain = stripVTControlCharacters(output);
    if (status === 'complete') {
      expect(plain).toContain('\n✓ Build succeeded.\n\n');
    } else {
      expect(plain).toContain(`Build ${status}.`);
      expect(plain).not.toContain('✓');
    }
  },
);

describe('isFatalFollowError', () => {
  it('treats every 4xx except 429 as fatal (including 426 cli_outdated)', () => {
    // 426 cli_outdated: a too-old CLI must exit, not retry forever.
    for (const status of [400, 401, 403, 404, 409, 410, 422, 426]) {
      expect(isFatalFollowError(apiError(status))).toBe(true);
    }
  });

  it('treats 429 (rate limit) as transient — the tail must survive it', () => {
    expect(isFatalFollowError(apiError(429))).toBe(false);
  });

  it('treats 5xx and non-PlatformApiError failures as transient', () => {
    expect(isFatalFollowError(apiError(500))).toBe(false);
    expect(isFatalFollowError(apiError(502))).toBe(false);
    expect(isFatalFollowError(apiError(503))).toBe(false);
    expect(isFatalFollowError(new Error('network blip'))).toBe(false);
    expect(isFatalFollowError('nope')).toBe(false);
  });
});

describe('followBuildLogs', () => {
  it('polls from the cursor, writes new lines in order, and stops when terminal', async () => {
    const pages: Array<BuildLogsResponse> = [
      page({
        lines: [{ seq: 2, line: 'b', stream: 'stdout', ts: 2 }],
        lastSeq: 2,
        status: 'building',
        terminal: false,
      }),
      page({
        lines: [{ seq: 3, line: 'c', stream: 'stderr', ts: 3 }],
        lastSeq: 3,
        status: 'complete',
        terminal: true,
        logsComplete: true,
      }),
    ];
    const sinceCalls: Array<number> = [];
    const written: Array<string> = [];
    let i = 0;

    const result = await followBuildLogs({
      fetchPage: (since) => {
        sinceCalls.push(since);
        return Promise.resolve(pages[i++]!);
      },
      write: (line) => written.push(line),
      sleep: () => Promise.resolve(),
      since: 1,
      pollMs: 0,
    });

    expect(sinceCalls).toEqual([1, 2]); // advances cursor to each page's lastSeq
    expect(written).toEqual(['b', 'c']);
    expect(result).toEqual({ status: 'complete', terminal: true });
  });

  it('survives a transient fetch failure: onRetry once, no cursor advance, then continues', async () => {
    const sinceCalls: Array<number> = [];
    const written: Array<string> = [];
    const retries: Array<unknown> = [];
    let call = 0;

    const result = await followBuildLogs({
      fetchPage: (since) => {
        sinceCalls.push(since);
        call += 1;
        if (call === 1) {
          // Transient blip on the first poll (e.g. a 502/timeout).
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve(
          page({
            lines: [{ seq: 3, line: 'c', stream: 'stdout', ts: 3 }],
            lastSeq: 3,
            status: 'complete',
            terminal: true,
            logsComplete: true,
          }),
        );
      },
      write: (line) => written.push(line),
      sleep: () => Promise.resolve(),
      since: 2,
      pollMs: 0,
      isFatal: () => false,
      onRetry: (err) => retries.push(err),
    });

    // The failed attempt did NOT advance the cursor: the retry re-requests since=2.
    expect(sinceCalls).toEqual([2, 2]);
    expect(retries).toHaveLength(1); // onRetry called exactly once
    expect((retries[0] as Error).message).toBe('boom');
    // Nothing written on the failed attempt; terminal page's lines written after.
    expect(written).toEqual(['c']);
    expect(result).toEqual({ status: 'complete', terminal: true });
  });

  it('rethrows a fatal fetch failure (isFatal → true)', async () => {
    await expect(
      followBuildLogs({
        fetchPage: () => Promise.reject(new Error('unauthorized')),
        write: () => {},
        sleep: () => Promise.resolve(),
        since: 1,
        pollMs: 0,
        isFatal: () => true,
      }),
    ).rejects.toThrow('unauthorized');
  });

  it('keeps reading terminal pages until delayed final logs are captured', async () => {
    const pages = [
      page({ status: 'complete', terminal: true, logsComplete: false, lastSeq: 2 }),
      page({
        status: 'complete',
        terminal: true,
        logsComplete: true,
        lines: [{ seq: 3, line: 'final tail', stream: 'stdout', ts: 3 }],
        lastSeq: 3,
      }),
    ];
    const sinceCalls: Array<number> = [];
    const written: Array<string> = [];

    await followBuildLogs({
      fetchPage: (since) => {
        sinceCalls.push(since);
        return Promise.resolve(pages.shift()!);
      },
      write: (line) => written.push(line),
      sleep: () => Promise.resolve(),
      since: 2,
    });

    expect(sinceCalls).toEqual([2, 2]);
    expect(written).toEqual(['final tail']);
  });

  it('prints retained logs before rejecting null completion proof', async () => {
    const written: Array<string> = [];
    await expect(
      followBuildLogs({
        fetchPage: () =>
          Promise.resolve(
            page({
              status: 'complete',
              terminal: true,
              logsComplete: null,
              lines: [{ seq: 3, line: 'retained tail', stream: 'stdout', ts: 3 }],
              lastSeq: 3,
            }),
          ),
        write: (line) => written.push(line),
        sleep: () => Promise.resolve(),
        since: 2,
      }),
    ).rejects.toThrow('upgrade the platform runtime');
    expect(written).toEqual(['retained tail']);
  });

  it('bounds terminal drain waiting at two minutes', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let fetches = 0;
    await expect(
      followBuildLogs({
        fetchPage: () => {
          fetches++;
          return Promise.resolve(page({ status: 'complete', terminal: true, logsComplete: false }));
        },
        write: () => {},
        sleep: () => {
          now += 60_000;
          return Promise.resolve();
        },
        since: 0,
      }),
    ).rejects.toThrow('did not confirm completion');
    expect(fetches).toBe(3);
  });

  it('follows an initially terminal build whose producer has not drained', async () => {
    vi.useFakeTimers();
    // Bind this fixture token explicitly so a saved platform cannot select the destination.
    vi.stubEnv('VOID_TOKEN', 'test-build-logs-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    const registry = mkdtempSync(join(tmpdir(), 'void-build-connections-'));
    registries.push(registry);
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', registry);
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://api.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Test',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });
    vi.stubEnv('VOID_PROJECT', '');
    vi.spyOn(PlatformClient.prototype, 'listProjects').mockResolvedValue([
      { id: 'project', slug: 'project' } as Awaited<
        ReturnType<PlatformClient['listProjects']>
      >[number],
    ]);
    const logs = vi
      .spyOn(PlatformClient.prototype, 'getBuildLogs')
      .mockResolvedValueOnce(
        page({ terminal: true, status: 'complete', logsComplete: false, lastSeq: 2 }),
      )
      .mockResolvedValueOnce(
        page({
          terminal: true,
          status: 'complete',
          logsComplete: true,
          lastSeq: 3,
          lines: [{ seq: 3, line: 'delayed tail', stream: 'stdout', ts: 3 }],
        }),
      );
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});

    const run = runBuildCommand(process.cwd(), {
      subcommand: 'logs',
      buildId: 'build',
      projectName: 'project',
      follow: true,
    });
    await vi.runAllTimersAsync();
    await run;

    expect(logs.mock.calls.map(([, , since]) => since)).toEqual([0, 2]);
    expect(write.mock.calls.flat()).toContain('delayed tail');
  });
});
