import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { openDeployLog } from '../../src/cli/log-file.ts';
import {
  buildDeployLogSummary,
  formatDeployLogSummary,
  LOG_ERROR_LIMIT,
  LOG_TAIL_LIMIT,
} from '../../src/cli/log-summary.ts';

// picocolors enables color whenever `CI` is set or stdout is a TTY, so the
// assertions below compare against the plain text.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function plain(text: string | null): string {
  return (text ?? '').replaceAll(ANSI, '');
}

function line(record: Record<string, unknown>): string {
  return JSON.stringify({ ts: 1_700_000_000_000, ...record });
}

describe('formatDeployLogSummary', () => {
  it('returns null when there is nothing to summarize', () => {
    expect(formatDeployLogSummary([])).toBeNull();
    expect(formatDeployLogSummary(['', '   ', ''])).toBeNull();
  });

  it('returns null when every line is malformed', () => {
    expect(formatDeployLogSummary(['not json', '{"broken":'])).toBeNull();
  });

  it('skips malformed lines but keeps the valid ones', () => {
    const out = plain(
      formatDeployLogSummary([
        'not json',
        line({ elapsedMs: 0, lvl: 'info', msg: 'deploy_start' }),
        '{"broken":',
      ]),
    );

    expect(out).toContain('deploy_start');
    expect(out).toContain('Log (1 entry)');
  });

  it('formats a tail with elapsed seconds, level, message, and fields', () => {
    const out = plain(
      formatDeployLogSummary([
        line({ elapsedMs: 0, lvl: 'info', msg: 'deploy_start', dir: 'docs/.vitepress/dist' }),
        line({ elapsedMs: 8412, lvl: 'info', msg: 'finalize_start', assets: 98 }),
        line({ elapsedMs: 8952, lvl: 'warn', msg: 'stream_no_terminal_event' }),
      ]),
    );

    expect(out).toContain('Log (3 entries)');
    expect(out).toContain('0.0s');
    expect(out).toContain('8.4s');
    expect(out).toContain('9.0s');
    expect(out).toContain('deploy_start');
    expect(out).toContain('dir=docs/.vitepress/dist');
    expect(out).toContain('assets=98');
    expect(out).toContain('warn');
  });

  it('caps the tail and reports how many entries were dropped', () => {
    const lines = Array.from({ length: LOG_TAIL_LIMIT + 5 }, (_, i) =>
      line({ elapsedMs: i * 100, lvl: 'info', msg: `step_${i}` }),
    );

    const out = plain(formatDeployLogSummary(lines));

    expect(out).toContain(`Last ${LOG_TAIL_LIMIT} of ${LOG_TAIL_LIMIT + 5} entries`);
    expect(out).not.toContain('step_0 ');
    expect(out).toContain(`step_${LOG_TAIL_LIMIT + 4}`);
  });

  it('lists error records with their flattened cause chain', () => {
    const out = plain(
      formatDeployLogSummary([
        line({ elapsedMs: 10, lvl: 'info', msg: 'deploy_start' }),
        line({
          elapsedMs: 8952,
          lvl: 'error',
          msg: 'deploy_server_error',
          deploymentId: 'dpl_abc',
          err: {
            name: 'PlatformApiError',
            message: 'Deploy failed',
            code: 409,
            cause: { name: 'TypeError', message: 'fetch failed' },
          },
        }),
      ]),
    );

    expect(out).toContain('Errors');
    expect(out).toContain('deploy_server_error');
    expect(out).toContain('deploymentId=dpl_abc');
    expect(out).toContain('PlatformApiError: Deploy failed (code=409) -> TypeError: fetch failed');
  });

  it('caps the error list and reports how many were dropped', () => {
    const lines = Array.from({ length: LOG_ERROR_LIMIT + 2 }, (_, i) =>
      line({ elapsedMs: i, lvl: 'error', msg: `boom_${i}` }),
    );

    const out = plain(formatDeployLogSummary(lines));

    expect(out).toContain('(+2 more)');
  });

  it('omits the terminal deploy_end record from the error list', () => {
    const out = plain(
      formatDeployLogSummary([
        line({ elapsedMs: 10, lvl: 'error', msg: 'deploy_server_error', reason: 'in progress' }),
        line({
          elapsedMs: 11,
          lvl: 'error',
          msg: 'deploy_end',
          ok: false,
          err: { name: 'Error', message: 'deploy: Deploy failed' },
        }),
      ]),
    );

    const errorBlock = out.slice(out.indexOf('Errors'), out.indexOf('Log ('));
    expect(errorBlock).toContain('deploy_server_error');
    expect(errorBlock).not.toContain('deploy_end');
    // Still visible in the tail, where it is a single truncated line.
    expect(out).toContain('deploy_end');
  });

  it('returns only the tail when no record has error level', () => {
    const out = plain(
      formatDeployLogSummary([line({ elapsedMs: 0, lvl: 'info', msg: 'deploy_start' })]),
    );

    expect(out).not.toContain('Errors');
    expect(out).toContain('Log (1 entry)');
  });

  it('collapses newlines inside field values onto one line', () => {
    const out = plain(
      formatDeployLogSummary([
        line({ elapsedMs: 0, lvl: 'info', msg: 'note', detail: 'first\nsecond\n\nthird' }),
      ]),
    );

    expect(out).toContain('detail=first second third');
  });

  // Void masks the credentials it emits itself. Fields it names are its own,
  // so a credential-shaped key is masked whatever the value looks like.
  it('masks a field whose key names a credential', () => {
    const out = plain(
      formatDeployLogSummary([
        line({
          elapsedMs: 0,
          lvl: 'info',
          msg: 'note',
          apiToken: 'sk_live_abcdef',
          sessionCookie: 'sid=zzz',
          privateKey: 'MIIEpAIBAAKCAQ',
          slug: 'my-app',
        }),
      ]),
    );

    expect(out).toContain('apiToken=[redacted]');
    expect(out).toContain('sessionCookie=[redacted]');
    expect(out).toContain('privateKey=[redacted]');
    expect(out).not.toContain('sk_live_abcdef');
    expect(out).not.toContain('MIIEpAIBAAKCAQ');
    // A non-credential key keeps its value, or the tail stops being useful.
    expect(out).toContain('slug=my-app');
  });

  // Scrubbing user-supplied values is left to the CI platform, which owns the
  // secrets and masks them before the log is written. Void neither guesses at
  // credential-shaped names nor parses credentials out of values it was handed.
  it('passes user-supplied values through unchanged', () => {
    const out = plain(
      formatDeployLogSummary([
        line({
          elapsedMs: 0,
          lvl: 'info',
          msg: 'build_start',
          command: 'DATABASE_URL=postgres://appuser:hunter2@db.host/app npm run build',
        }),
        line({
          elapsedMs: 1,
          lvl: 'info',
          msg: 'note',
          registry: 'https://deploy:s3cr3t@npm.internal/',
        }),
      ]),
    );

    expect(out).toContain('DATABASE_URL=postgres://appuser:hunter2@db.host/app npm run build');
    expect(out).toContain('https://deploy:s3cr3t@npm.internal/');
  });

  it('leaves a credential-free URL untouched', () => {
    const out = plain(
      formatDeployLogSummary([
        line({
          elapsedMs: 0,
          lvl: 'info',
          msg: 'deploy_post',
          endpoint: 'https://api.void.app/projects/prj_9k1/deploy',
        }),
      ]),
    );

    expect(out).toContain('https://api.void.app/projects/prj_9k1/deploy');
    expect(out).not.toContain('[redacted]');
  });

  it('redacts signed-URL query values and bearer tokens', () => {
    const out = plain(
      formatDeployLogSummary([
        line({
          elapsedMs: 0,
          lvl: 'info',
          msg: 'r2_put_start',
          url: 'https://r2.example.com/a?X-Amz-Signature=deadbeefcafe&x-id=PutObject',
          auth: 'Bearer sk_live_0123456789abcdef',
        }),
      ]),
    );

    expect(out).not.toContain('deadbeefcafe');
    expect(out).not.toContain('sk_live_0123456789abcdef');
    expect(out).toContain('[redacted]');
  });

  // The file is data, not a typed value. A summary that throws would replace
  // the deploy failure it is supposed to explain.
  it('does not throw on an ill-typed err node', () => {
    const cases: Array<unknown> = [
      { message: 123 },
      { name: 5, message: 'x' },
      { message: 'x', cause: 7 },
      123,
      true,
      [],
      {},
    ];

    for (const err of cases) {
      const out = plain(
        formatDeployLogSummary([line({ elapsedMs: 0, lvl: 'error', msg: 'boom', err })]),
      );
      expect(out).toContain('boom');
    }
  });

  it('renders a numeric err message rather than dropping it', () => {
    const out = plain(
      formatDeployLogSummary([line({ elapsedMs: 0, lvl: 'error', msg: 'boom', err: 123 })]),
    );

    expect(out).toContain('err=123');
  });

  it('truncates a long field value', () => {
    const out = plain(
      formatDeployLogSummary([
        line({ elapsedMs: 0, lvl: 'info', msg: 'note', detail: 'x'.repeat(500) }),
      ]),
    );

    expect(out).toContain('...');
    expect(out).not.toContain('x'.repeat(200));
  });
});

describe('buildDeployLogSummary', () => {
  it('returns null when there is no log path', () => {
    expect(buildDeployLogSummary(null)).toBeNull();
    expect(buildDeployLogSummary(undefined)).toBeNull();
  });

  it('returns null when the file cannot be read', () => {
    expect(buildDeployLogSummary('/definitely/not/a/real/deploy-log.jsonl')).toBeNull();
  });

  // `runDeploy` closes the logger and then reads the file straight back, so a
  // record written moments earlier has to be on disk by the time close resolves.
  it('reads back records a real logger wrote once close() resolves', async () => {
    const cliLog = openDeployLog();
    expect(cliLog.path).not.toBeNull();
    const path = cliLog.path!;

    try {
      cliLog.info('deploy_start', { dir: 'dist' });
      cliLog.error('deploy_server_error', new Error('boom'), { deploymentId: 'dpl_1' });
      await cliLog.close();

      const out = plain(buildDeployLogSummary(path));
      expect(out).toContain('deploy_start');
      expect(out).toContain('dir=dist');
      expect(out).toContain('Errors');
      expect(out).toContain('err=Error: boom');
    } finally {
      rmSync(path, { force: true });
    }
  });
});
