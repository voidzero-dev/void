import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vite-plus/test';

// Deploy-log tests point homedir() at a temp folder; every other caller keeps the real one.
const logHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => logHome.dir || actual.homedir() };
});

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  cancel: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

import type { SpinnerResult } from '@voidzero-dev/vite-plus-prompts';
import {
  applyDeployEvent,
  streamDeployEvents,
  warnIgnoredNotFoundForFramework,
  warnUnpublishedRouting,
} from '../../src/cli/deploy-managed-events.ts';
import { openDeployLog, type CliLogger } from '../../src/cli/log-file.ts';
import type { DeployEvent } from '../../src/cli/types.ts';

type DoneEvent = Extract<DeployEvent, { event: 'done' }>;

function createMockCliLog() {
  const calls = {
    info: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
    warn: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
    error: [] as Array<{ msg: string }>,
  };
  const logger: CliLogger = {
    info: (msg, fields) => {
      calls.info.push({ msg, fields });
    },
    warn: (msg, fields) => {
      calls.warn.push({ msg, fields });
    },
    error: (msg) => {
      calls.error.push({ msg });
    },
    debug: () => {},
    path: null,
    close: async () => {},
  };
  return { logger, calls };
}

async function* eventsOf(events: ReadonlyArray<DeployEvent>): AsyncGenerator<DeployEvent> {
  for (const event of events) {
    yield event;
  }
}

function createMockSpinner() {
  const calls = {
    start: [] as Array<unknown>,
    stop: [] as Array<unknown>,
    message: [] as Array<unknown>,
    clear: [] as Array<unknown>,
  };
  return {
    spinner: {
      start: (m?: unknown) => {
        calls.start.push(m);
      },
      stop: (m?: unknown) => {
        calls.stop.push(m);
      },
      message: (m?: unknown) => {
        calls.message.push(m);
      },
      clear: () => {
        calls.clear.push(true);
      },
    } as unknown as SpinnerResult,
    calls,
  };
}

describe('applyDeployEvent', () => {
  it('shows interrupted deployment recovery from a heartbeat', () => {
    const { spinner, calls } = createMockSpinner();
    applyDeployEvent({ event: 'heartbeat', step: 'recovery', status: 'recovering' }, spinner);
    expect(calls.message).toEqual(['Recovering interrupted deployment...']);
  });
  it('shows queue_setup progress message so the user sees it mid-deploy', async () => {
    const { spinner, calls } = createMockSpinner();
    const result = applyDeployEvent(
      { event: 'queue_setup', queues: ['emails', 'jobs'] } satisfies DeployEvent,
      spinner,
    );
    expect(result).toEqual({ kind: 'continue' });
    expect(calls.message).toHaveLength(1);
    expect(String(calls.message[0])).toMatch(/emails/);
    expect(String(calls.message[0])).toMatch(/jobs/);
  });

  it('logs a persistent warning for queue_consumer_conflict instead of a transient spinner message', async () => {
    const { spinner, calls } = createMockSpinner();
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    const result = applyDeployEvent(
      {
        event: 'queue_consumer_conflict',
        queue: 'emails',
        ownerScript: 'other-dispatch',
      } satisfies DeployEvent,
      spinner,
    );

    expect(result).toEqual({ kind: 'continue' });
    // Warning must use log.warn (persists above the spinner) so the user sees
    // it after deploy completes — NOT s.message (gets overwritten).
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toMatch(/emails/);
    expect(msg).toMatch(/other-dispatch/);
    expect(calls.message).toHaveLength(0);
  });

  it('logs migration_warning above the spinner so it stays visible after deploy', async () => {
    const { spinner, calls } = createMockSpinner();
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    const result = applyDeployEvent(
      { event: 'migration_warning', message: 'Migration 0002 was edited after apply' },
      spinner,
    );

    expect(result).toEqual({ kind: 'continue' });
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith('Migration 0002 was edited after apply');
    expect(calls.message).toHaveLength(0);
  });

  it('describes migration_start as checking bundled migrations, not running them', () => {
    const { spinner, calls } = createMockSpinner();
    applyDeployEvent({ event: 'migration_start', pending: 1 }, spinner);
    applyDeployEvent({ event: 'migration_start', pending: 3 }, spinner);
    expect(calls.message).toEqual([
      'Checking 1 bundled migration...',
      'Checking 3 bundled migrations...',
    ]);
  });

  it('returns {kind:"start"} with deploymentId so the caller can capture it', () => {
    const { spinner } = createMockSpinner();
    const result = applyDeployEvent(
      { event: 'start', deploymentId: 'dpl_abc' } satisfies DeployEvent,
      spinner,
    );
    expect(result).toEqual({ kind: 'start', deploymentId: 'dpl_abc' });
  });

  it('shows worker readiness before migration execution starts', () => {
    const { spinner, calls } = createMockSpinner();
    const result = applyDeployEvent({ event: 'worker_readiness' } satisfies DeployEvent, spinner);
    expect(result).toEqual({ kind: 'continue' });
    expect(calls.message[0]).toBe('Waiting for worker to become reachable...');
  });

  it('returns {kind:"done"} and clears the spinner before the summary', () => {
    const { spinner, calls } = createMockSpinner();
    const done: Extract<DeployEvent, { event: 'done' }> = {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
    };
    const result = applyDeployEvent(done, spinner);
    expect(result).toEqual({ kind: 'done', event: done });
    expect(calls.clear).toHaveLength(1);
    expect(calls.stop).toHaveLength(0);
  });

  it('degrades the done message when published is false but still resolves as a committed done', () => {
    const { spinner, calls } = createMockSpinner();
    const done: DoneEvent = {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
      published: false,
    };
    const result = applyDeployEvent(done, spinner);
    // Committed-live: still a `done` kind, NOT an error.
    expect(result).toEqual({ kind: 'done', event: done });
    const msg = String(calls.stop[0]);
    expect(msg).toMatch(/routing was not published/i);
    expect(msg).not.toBe('Deployed!');
  });

  it('returns {kind:"error"} for error event', () => {
    const { spinner, calls } = createMockSpinner();
    const result = applyDeployEvent(
      { event: 'error', message: 'bad things', step: 'worker_upload' } satisfies DeployEvent,
      spinner,
    );
    expect(result).toEqual({ kind: 'error', message: 'bad things' });
    expect(calls.stop[0]).toBe('Deploy failed');
  });
});

it('explains stalled deployment progress once and reports recovery without claiming completion', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { log } = await import('@voidzero-dev/vite-plus-prompts');
  const warn = log.warn as ReturnType<typeof vi.fn>;
  const info = log.info as ReturnType<typeof vi.fn>;
  warn.mockClear();
  info.mockClear();
  const { spinner } = createMockSpinner();
  const { logger, calls } = createMockCliLog();
  const recoveryAt = new Date(Date.now() + 18 * 60_000).toISOString();
  async function* events(): AsyncGenerator<DeployEvent> {
    yield { event: 'start', deploymentId: 'dpl_stalled' };
    yield { event: 'queue_setup', queues: ['demo-queue'] };
    vi.setSystemTime(Date.now() + 90_000);
    yield { event: 'heartbeat', step: 'queue_setup', status: 'running', recoveryAt };
    yield { event: 'heartbeat', step: 'queue_setup', status: 'running', recoveryAt };
    yield { event: 'heartbeat', step: 'recovery', status: 'recovering', recoveryAt };
    yield { event: 'heartbeat', step: 'recovery', status: 'recovering', recoveryAt };
    yield {
      event: 'done',
      deployment: 'dpl_stalled',
      url: 'https://app.test',
      urls: [],
      assets: 0,
      workers: 1,
    };
  }
  try {
    expect(await streamDeployEvents('proj_test', events(), spinner, logger)).toMatchObject({
      deployment: 'dpl_stalled',
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('dpl_stalled');
    expect(warn.mock.calls[0][0]).toContain(recoveryAt);
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain('recovering');
    expect(calls.warn).toContainEqual({
      msg: 'deploy_progress_stalled',
      fields: expect.objectContaining({
        deploymentId: 'dpl_stalled',
        step: 'queue_setup',
        status: 'running',
        recoveryAt,
      }),
    });
  } finally {
    vi.useRealTimers();
  }
});

describe('streamDeployEvents', () => {
  // Ctrl-C during a managed deploy exits with 130 without awaiting anything, so the records
  // must already be on disk. The log goes to a temp home folder.
  it('has every managed deploy record on disk when Ctrl-C exits', async () => {
    logHome.dir = mkdtempSync(join(tmpdir(), 'void-deploy-log-'));
    const { spinner } = createMockSpinner();
    const cliLog = openDeployLog();
    expect(cliLog.path).not.toBeNull();
    expect(dirname(resolve(cliLog.path!))).toBe(resolve(logHome.dir, '.void', 'logs'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const before = new Set(process.listeners('SIGINT'));
    let reachedWait!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reachedWait = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* events(): AsyncGenerator<DeployEvent> {
      yield { event: 'start', deploymentId: 'dpl_1' };
      reachedWait();
      await released;
    }
    try {
      const stream = streamDeployEvents('proj_1', events(), spinner, cliLog);
      await waiting;
      const onSigint = process.listeners('SIGINT').find((listener) => !before.has(listener));
      expect(onSigint).toBeTypeOf('function');
      // Call the handler directly: emitting SIGINT would reach the test runner's own handlers.
      (onSigint as () => void)();
      expect(exit).toHaveBeenCalledWith(130);

      const lines = readFileSync(cliLog.path!, 'utf8').trimEnd().split('\n');
      expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual([
        'stream_start',
        'stream_deployment_id',
        'stream_interrupted',
      ]);

      release();
      await expect(stream).rejects.toThrow();
    } finally {
      exit.mockRestore();
      await cliLog.close();
      rmSync(logHome.dir, { recursive: true, force: true });
      logHome.dir = '';
    }
  });

  it('logs deploy_success and returns the done event on a published deploy', async () => {
    const { spinner } = createMockSpinner();
    const { logger, calls } = createMockCliLog();
    const done: DoneEvent = {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
    };

    const result = await streamDeployEvents(
      'proj_1',
      eventsOf([{ event: 'start', deploymentId: 'dpl_1' }, done]),
      spinner,
      logger,
    );

    expect(result).toEqual(done);
    const keys = calls.info.map((c) => c.msg);
    expect(keys).toContain('deploy_success');
    expect(keys).not.toContain('deploy_degraded');
    const success = calls.info.find((c) => c.msg === 'deploy_success');
    expect(success?.fields?.degraded).toBe(false);
  });

  it('logs deploy_degraded (not deploy_success) and still returns the committed done event when published is false', async () => {
    const { spinner } = createMockSpinner();
    const { logger, calls } = createMockCliLog();
    const done: DoneEvent = {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
      published: false,
    };

    const result = await streamDeployEvents(
      'proj_1',
      eventsOf([{ event: 'start', deploymentId: 'dpl_1' }, done]),
      spinner,
      logger,
    );

    // Resolves as a committed deploy — no throw, returns the done event.
    expect(result).toEqual(done);
    const keys = calls.info.map((c) => c.msg);
    expect(keys).toContain('deploy_degraded');
    expect(keys).not.toContain('deploy_success');
    const degraded = calls.info.find((c) => c.msg === 'deploy_degraded');
    expect(degraded?.fields?.degraded).toBe(true);
  });
});

describe('warnUnpublishedRouting', () => {
  function makeDone(published?: boolean): DoneEvent {
    return {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
      ...(published === undefined ? {} : { published }),
    };
  }

  it('warns persistently when routing was not published', async () => {
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    warnUnpublishedRouting(makeDone(false));

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/routing was not published/i);
  });

  it('does not warn when published is true or omitted', async () => {
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;

    warnSpy.mockClear();
    warnUnpublishedRouting(makeDone(true));
    warnUnpublishedRouting(makeDone(undefined));

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// Class B/C framework deploys pin `not_found_handling: 'none'` and never read
// `routing.notFound`. The config validator accepts the key in every mode, so
// without this warning the option looks supported and silently does nothing.
describe('warnIgnoredNotFoundForFramework', () => {
  it('warns, naming the framework and the pinned value, when routing.notFound is set', async () => {
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    warnIgnoredNotFoundForFramework('404-page', 'astro');

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain('"routing.notFound"');
    expect(msg).toContain('astro');
    expect(msg).toContain('"none"');
    expect(msg).toMatch(/ignored/i);
  });

  it('warns for every accepted value, including the pinned one', async () => {
    // Even `'none'` warns: it happens to match what the path pins, but the key
    // is still not read, and staying silent there would teach that it works.
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;

    for (const value of ['single-page-application', '404-page', 'none'] as const) {
      warnSpy.mockClear();
      warnIgnoredNotFoundForFramework(value, 'sveltekit');
      expect(warnSpy).toHaveBeenCalledOnce();
    }
  });

  it('does not warn when routing.notFound is unset', async () => {
    const { log } = await import('@voidzero-dev/vite-plus-prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    warnIgnoredNotFoundForFramework(undefined, 'nuxt');

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
