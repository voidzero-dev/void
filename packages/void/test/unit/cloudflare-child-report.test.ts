import { cloudflareCommandDiagnostic, type CloudflareOperation } from '@void/deploy-cloudflare';
import { describe, expect, it } from 'vite-plus/test';
import {
  cfOperationName,
  createCloudflareChildReporter,
  createCredentialRedactor,
  describeCloudflareChildFailure,
  formatCloudflareChildFailure,
  observeCfCommand,
  observeCloudflareRunner,
  scrubCloudflareResult,
} from '../../src/cli/cloudflare-child-report.ts';
import type { DeployWranglerRunResult } from '../../src/cli/deploy-types.ts';
import type { CliLogger } from '../../src/cli/log-file.ts';

const TOKEN = 'fake-cloudflare-api-token-0123456789';

function recordingLog(): { log: CliLogger; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const log: CliLogger = {
    info: (msg, fields) => calls.push([msg, fields]),
    warn: (msg, fields) => calls.push([msg, fields]),
    error: (msg, err, fields) => calls.push([msg, { err, fields }]),
    debug: (msg, fields) => calls.push([msg, fields]),
    path: null,
    close: async () => {},
  };
  return { log, calls };
}

describe('createCredentialRedactor', () => {
  it('removes an exact token from stderr, error, errors[] and an Error stack', async () => {
    const redactor = createCredentialRedactor({ CLOUDFLARE_API_TOKEN: TOKEN });
    const scrubbed = scrubCloudflareResult(
      {
        status: 1,
        stdout: `stdout ${TOKEN}`,
        stderr: `boom raw ${TOKEN}`,
        error: `spawn failed ${TOKEN}`,
        errors: [{ code: 10000, message: `provider ${TOKEN}` }],
      },
      redactor,
    );
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    expect(scrubbed.stderr).toBe('boom raw <redacted>');
    expect(scrubbed.errors).toEqual([{ code: 10000, message: 'provider <redacted>' }]);

    const error = new Error(`thrown ${TOKEN}`);
    const reporter = { ...createCloudflareChildReporter(recordingLog().log), redactor };
    const run = observeCloudflareRunner(() => {
      throw error;
    }, reporter);
    await expect(run({ type: 'auth.whoami' }, { capture: true })).rejects.toBe(error);
    expect(error.message).toBe('thrown <redacted>');
    expect(error.stack).not.toContain(TOKEN);
  });

  it('scrubs before truncation, so a token across the 4096-char cap leaks no prefix', () => {
    const redactor = createCredentialRedactor({ CLOUDFLARE_API_TOKEN: TOKEN });
    // The token starts 10 chars before the formatter's cut.
    const stderr = `${'x'.repeat(4086)}${TOKEN}\nmore`;
    const unsafe = cloudflareCommandDiagnostic({ status: 1, stdout: '', stderr })!;
    expect(unsafe).toContain(TOKEN.slice(0, 10));
    const diagnostic = cloudflareCommandDiagnostic(
      scrubCloudflareResult({ status: 1, stdout: '', stderr }, redactor),
    )!;
    expect(diagnostic).not.toContain(TOKEN.slice(0, 10));
  });

  it('ignores short values, skips non-secret identifiers and replaces longer values first', () => {
    const redactor = createCredentialRedactor({
      CF_API_KEY: 'short',
      CLOUDFLARE_EMAIL: 'person@example.test',
      CLOUDFLARE_ACCESS_CLIENT_ID: 'client-id-0123456789',
      CLOUDFLARE_API_TOKEN: 'abcdefgh',
      CF_API_TOKEN: 'abcdefgh-longer-value',
      CF_ACCESS_CLIENT_SECRET: 'access-client-secret-value',
    });
    expect(
      redactor.redact(
        'short person@example.test client-id-0123456789 abcdefgh-longer-value abcdefgh access-client-secret-value',
      ),
    ).toBe('short person@example.test client-id-0123456789 <redacted> <redacted> <redacted>');
  });

  it('covers an OAuth bearer learned at run time through add()', () => {
    const redactor = createCredentialRedactor({});
    expect(redactor.redact(`x ${TOKEN}`)).toBe(`x ${TOKEN}`);
    redactor.add(TOKEN);
    expect(redactor.redact(`x ${TOKEN}`)).toBe('x <redacted>');
  });
});

describe('observeCloudflareRunner', () => {
  it('learns the auth.token bearer and never logs its stdout, data or input', async () => {
    const { log, calls } = recordingLog();
    const reporter = createCloudflareChildReporter(log, {});
    const results: Record<string, DeployWranglerRunResult> = {
      'auth.token': {
        status: 0,
        stdout: `{"token":"${TOKEN}"}`,
        stderr: '',
        data: { type: 'oauth', token: TOKEN },
      },
      'auth.whoami': { status: 1, stdout: '', stderr: `cf echoed ${TOKEN}` },
    };
    const run = observeCloudflareRunner(
      (operation) => results[operation.type] ?? { status: 0, stdout: '', stderr: '' },
      reporter,
    );
    const token = await run({ type: 'auth.token', configPath: '/p/wrangler.jsonc' } as never, {
      capture: true,
      input: `secret-input-${TOKEN}\n`,
    });
    // The caller still gets the credential.
    expect(token.data).toEqual({ type: 'oauth', token: TOKEN });
    const whoami = await run({ type: 'auth.whoami' }, { capture: true });
    expect(whoami.stderr).toBe('cf echoed <redacted>');
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    expect(calls).toEqual([
      ['cloudflare_op', { op: 'auth.token', ok: true, status: 0, ms: expect.any(Number) }],
      [
        'cloudflare_op',
        {
          op: 'auth.whoami',
          ok: false,
          status: 1,
          ms: expect.any(Number),
          diagnostic: 'cf echoed <redacted>',
        },
      ],
    ]);
  });

  it('never formats a failed auth.token stdout', async () => {
    const { log, calls } = recordingLog();
    const run = observeCloudflareRunner(
      () => ({ status: 1, stdout: `[ERROR] envelope ${TOKEN}`, stderr: 'helper crashed' }),
      createCloudflareChildReporter(log, {}),
    );
    await run({ type: 'auth.token' } as CloudflareOperation, { capture: true });
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    expect(calls[0]![1]).toMatchObject({ ok: false, diagnostic: 'helper crashed' });
  });

  it('logs a signal and names cf commands without their values or flags', async () => {
    const { log, calls } = recordingLog();
    const run = observeCfCommand(
      () => ({ status: 1, stdout: '', stderr: '', signal: 'SIGKILL' }),
      createCloudflareChildReporter(log, {}),
    );
    await run(['workers', 'triggers', 'deploy', '--prebuilt'], { cwd: '/', capture: true });
    expect(calls).toEqual([
      [
        'cloudflare_op',
        {
          op: 'cf workers triggers deploy',
          ok: false,
          status: 1,
          signal: 'SIGKILL',
          ms: expect.any(Number),
        },
      ],
    ]);
    expect(cfOperationName(['secret', '--name', 'X'])).toBe('cf secret');
    expect(cfOperationName(['a', 'b', 'c', 'd'])).toBe('cf a b c');
  });
});

describe('describeCloudflareChildFailure', () => {
  it('names the exit code, the signal or the spawn error', () => {
    expect(describeCloudflareChildFailure({ status: 1 })).toBe(
      'the Void CLI helper process exited with code 1',
    );
    expect(describeCloudflareChildFailure({ status: 1, signal: 'SIGKILL' })).toBe(
      'the Void CLI helper process was stopped by SIGKILL',
    );
    expect(describeCloudflareChildFailure({ status: 1, error: 'spawn EACCES' })).toBe(
      'the Void CLI helper process could not run: spawn EACCES',
    );
    expect(
      formatCloudflareChildFailure({
        status: 1,
        stderr:
          "SyntaxError: The requested module 'node:http' does not provide an export named 'setGlobalProxyFromEnv'\n\nNode.js v22.23.4",
      }),
    ).toBe(
      [
        'the Void CLI helper process exited with code 1.',
        "SyntaxError: The requested module 'node:http' does not provide an export named 'setGlobalProxyFromEnv'",
        '',
        'Node.js v22.23.4',
      ].join('\n'),
    );
  });
});
