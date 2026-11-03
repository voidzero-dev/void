import { describe, expect, it } from 'vite-plus/test';
import { cloudflareCommandDiagnostic } from '../../src/diagnostics.ts';

describe('Cloudflare command diagnostics', () => {
  it('extracts a multiline error and strips terminal formatting and log banners', () => {
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "do-not-echo"',
        stderr:
          '\u001b[33m▲ [WARNING] A warning\u001b[0m\n' +
          '\u001b[31m✘ [ERROR]\u001b[0m A request to the Cloudflare API failed.\r\n\r\n' +
          '  Compatibility flag specified multiple times: nodejs_als [code: 10021]\r\n' +
          '\n🪵 Logs were written to "debug.log"',
      }),
    ).toBe(
      'A request to the Cloudflare API failed.\n\n  Compatibility flag specified multiple times: nodejs_als [code: 10021]',
    );
  });

  it('uses a marked stdout error without echoing preceding binding values', () => {
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "do-not-echo"\n✘ [ERROR] Upload failed.',
        stderr: '',
      }),
    ).toBe('Upload failed.');
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "do-not-echo"',
        stderr: '',
      }),
    ).toBeUndefined();
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "contains [ERROR] do-not-echo"',
        stderr: '',
      }),
    ).toBeUndefined();
  });

  it('uses cf error boxes on stdout when stderr contains a config warning', () => {
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout:
          'env.PRIVATE_VALUE: "do-not-echo"\n┌ APIError\n│ [10000] Worker upload failed.\n└\n',
        stderr: 'Processing worker.config.json:\n  - "unsafe" fields are experimental.',
      }),
    ).toBe('┌ APIError\n│ [10000] Worker upload failed.\n└');
  });

  it('keeps an error box and its advice on stderr without the binding table before it', () => {
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: '',
        // cf 1.0.0-beta.21 and later print upload progress and bindings on stderr.
        stderr: [
          '├  Upload',
          '│  Your Worker has access to the following bindings:',
          '│  Binding                               Resource',
          '│  env.PRIVATE_VALUE ("do-not-echo")     Environment Variable',
          '|  env.ASCII_VALUE ("do-not-echo")       Environment Variable',
          '│',
          '',
          '┌ APIError',
          '│ [10000] Authentication error [code: 10000]',
          '│',
          '│ 403 Forbidden',
          '└',
          '',
          '→ Check your API token permissions',
        ].join('\n'),
      }),
    ).toBe(
      '┌ APIError\n│ [10000] Authentication error [code: 10000]\n│\n│ 403 Forbidden\n└\n\n→ Check your API token permissions',
    );
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: '',
        stderr: '├  Upload\n│  env.PRIVATE_VALUE ("do-not-echo")\nUpload stopped.',
      }),
    ).toBe('Upload stopped.');
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: '',
        stderr: '├  Upload\n│  env.PRIVATE_VALUE ("do-not-echo")\n◆  Version upload complete',
      }),
    ).toBeUndefined();
  });

  it('reports upload conflicts from either stream without the config diff', () => {
    const abort =
      'Aborting the upload operation because of conflicts. To override and upload anyway, remove the `--strict` flag';
    const reason = 'You are about to upload a Worker that was last updated via the script API.';
    const scriptApi = [
      '├  Upload',
      `▲  ${reason}`,
      '│  Edits that have been made via the script API will be overridden by your local code and config.',
      `■  ${abort}`,
      '◆  Version upload complete',
    ].join('\n');
    // cf 1.0.0-beta.21 and later print upload messages on stderr, earlier releases on stdout.
    for (const [stdout, stderr] of [
      ['', scriptApi],
      [scriptApi, ''],
      // Without a Unicode terminal, cf prints fallback symbols.
      ['', scriptApi.replace('▲', '!').replace('■', 'x').replace('│', '|').replace('◆', '*')],
    ]) {
      expect(cloudflareCommandDiagnostic({ status: 1, stdout: stdout!, stderr: stderr! })).toBe(
        `${reason}\n${abort}`,
      );
    }
    expect(
      cloudflareCommandDiagnostic({
        status: 1,
        stdout: '',
        stderr: [
          '├  Upload',
          '▲  The local configuration being used (generated from your local configuration file) differs from the remote configuration of your Worker set via the Cloudflare Dashboard:',
          '│   {',
          '│     vars: {',
          '│  -    REMOTE_VALUE: "do-not-echo"',
          `│  +    LOCAL_VALUE: "${abort} do-not-echo"`,
          '│     }',
          '│   }',
          '│',
          '│  Uploading the Worker will override the remote configuration with your local one.',
          `■  ${abort}`,
          '◆  Version upload complete',
        ].join('\n'),
      }),
    ).toBe(abort);
  });

  it('retains plain stderr and process-spawn failures', () => {
    expect(
      cloudflareCommandDiagnostic({ status: 1, stdout: '', stderr: 'Unknown argument: strict' }),
    ).toBe('Unknown argument: strict');
    expect(
      cloudflareCommandDiagnostic({ status: 1, stdout: '', stderr: '', error: 'spawn ENOENT' }),
    ).toBe('spawn ENOENT');
  });

  it('redacts credentials before returning the diagnostic', () => {
    const diagnostic = cloudflareCommandDiagnostic({
      status: 1,
      stdout: '',
      stderr: [
        '✘ [ERROR] Authorization: Bearer bearer-value',
        'Authorization: Basic basic-value',
        'https://example.com/?X-Amz-Signature=signed-value&token=query-value',
        'postgres://user:password-value@example.com/db',
        'CLOUDFLARE_API_TOKEN="api-value"',
        'CF_ACCESS_CLIENT_SECRET=access-value',
      ].join('\n'),
    });
    for (const value of [
      'bearer-value',
      'basic-value',
      'signed-value',
      'query-value',
      'password-value',
      'api-value',
      'access-value',
    ]) {
      expect(diagnostic).not.toContain(value);
    }
    expect(diagnostic).toContain('Authorization: Bearer [redacted]');
    expect(diagnostic).toContain('postgres://[redacted]@example.com/db');
  });

  it('bounds large errors and long stack traces', () => {
    const diagnostic = (stderr: string) =>
      cloudflareCommandDiagnostic({ status: 1, stdout: '', stderr })!;
    expect(diagnostic('✘ [ERROR] ' + 'x'.repeat(10_000)).length).toBeLessThan(4200);
    expect(diagnostic('✘ [ERROR] ' + 'at index.js:42:1\n'.repeat(100)).split('\n')).toHaveLength(
      25,
    );
    expect(diagnostic('✘ [ERROR] ' + 'x'.repeat(10_000))).toContain('[diagnostic truncated]');
  });
});
