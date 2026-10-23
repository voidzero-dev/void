import { describe, expect, it } from 'vite-plus/test';
import { assertCleanPlatformWrangler } from '../../src/cli/platform-installer-errors.ts';

const UPLOAD_CONFLICT =
  'Aborting the upload operation because of conflicts. To override and upload anyway, remove the `--strict` flag';
const OUTSIDE_CHANGE_ADVICE =
  ' This Worker was changed outside Void. Run the same command in a terminal. Void then lists the changes and asks you before it replaces them.';

it('explains the cf upload conflict after a Workers API change without binding values', () => {
  const result = {
    status: 1,
    stderr: '',
    stdout: [
      'env.PRIVATE_VALUE: "do-not-echo"',
      '├  Upload',
      '▲  You are about to upload a Worker that was last updated via the script API.',
      '│  Edits that have been made via the script API will be overridden by your local code and config.',
      `■  ${UPLOAD_CONFLICT}`,
      '│',
      '◆  Version upload complete',
      '',
    ].join('\n'),
  };

  expect(() => assertCleanPlatformWrangler(result, 'upload test-worker')).toThrow(
    'platform: The Cloudflare CLI did not upload test-worker: ' +
      'You are about to upload a Worker that was last updated via the script API.' +
      OUTSIDE_CHANGE_ADVICE,
  );
  expect(() => assertCleanPlatformWrangler(result, 'upload test-worker')).not.toThrow(
    /do-not-echo|--strict|Wrangler/,
  );
});

it('explains the cf upload conflict after a dashboard change without its diff', () => {
  const result = {
    status: 1,
    stderr: '',
    stdout: [
      '├  Upload',
      '▲  The local configuration being used (generated from your local configuration file) differs from the remote configuration of your Worker set via the Cloudflare Dashboard:',
      '│   vars: {',
      '│ -   EMAIL_FROM: "Team <team@example.com>"',
      '│   }',
      '│  Uploading the Worker will override the remote configuration with your local one.',
      `■  ${UPLOAD_CONFLICT}`,
      '◆  Version upload complete',
    ].join('\n'),
  };

  expect(() => assertCleanPlatformWrangler(result, 'upload void-team-api')).toThrow(
    'platform: The Cloudflare CLI did not upload void-team-api: ' +
      'The local configuration being used (generated from your local configuration file) differs from the remote configuration of your Worker set via the Cloudflare Dashboard.' +
      OUTSIDE_CHANGE_ADVICE,
  );
  expect(() => assertCleanPlatformWrangler(result, 'upload void-team-api')).not.toThrow(
    /team@example\.com|--strict/,
  );
});

describe('cf upload conflicts that do not show a change outside Void', () => {
  const CONFLICT_ADVICE =
    ' It stopped the upload because of a conflict that it could not confirm without a terminal. Fix the conflict, then run the command again.';
  const upload = (warning: ReadonlyArray<string>) =>
    assertCleanPlatformWrangler(
      {
        status: 1,
        stderr: '',
        stdout: [
          '├  Upload',
          ...warning,
          `■  ${UPLOAD_CONFLICT}`,
          '│',
          '◆  Version upload complete',
        ].join('\n'),
      },
      'upload void-x-api',
    );

  const message = (warning: ReadonlyArray<string>) => {
    try {
      upload(warning);
    } catch (error) {
      return (error as Error).message;
    }
    return null;
  };
  // The Cloudflare CLI stopped, so its sentence about the replacement of the
  // secrets is not true.
  const SECRET_REPLACEMENT = /This deployment will replace|--strict|Wrangler|outside Void/;

  it('names the variables that have the name of a secret on the Worker', () => {
    const output = message([
      '▲  Environment variables `AUTH_REDIRECT_URI` and `DASHBOARD_URL` conflict with existing remote secrets. This deployment will replace these remote secrets with your environment variables.',
    ]);
    expect(output).toBe(
      'platform: The Cloudflare CLI did not upload void-x-api: the Worker has secrets with the same names as values that Void sets: `AUTH_REDIRECT_URI` and `DASHBOARD_URL`. Delete those secrets from the Worker in the Cloudflare dashboard, then run the command again.',
    );
    expect(output).not.toMatch(SECRET_REPLACEMENT);
  });

  it('names a binding that has the name of a secret on the Worker', () => {
    const output = message([
      '▲  Binding `ROUTING` conflicts with an existing remote secret. This deployment will replace the remote secret with your binding.',
    ]);
    expect(output).toBe(
      'platform: The Cloudflare CLI did not upload void-x-api: the Worker has a secret with the same name as a value that Void sets: `ROUTING`. Delete that secret from the Worker in the Cloudflare dashboard, then run the command again.',
    );
    expect(output).not.toMatch(SECRET_REPLACEMENT);
  });

  it('names variables and bindings that have the names of secrets on the Worker', () => {
    const output = message([
      '▲  Configuration values (`AUTH_REDIRECT_URI`, `DASHBOARD_URL`, and `ROUTING`) conflict with existing remote secrets. This deployment will replace these remote secrets with the configuration values.',
    ]);
    expect(output).toBe(
      'platform: The Cloudflare CLI did not upload void-x-api: the Worker has secrets with the same names as values that Void sets: `AUTH_REDIRECT_URI`, `DASHBOARD_URL`, and `ROUTING`. Delete those secrets from the Worker in the Cloudflare dashboard, then run the command again.',
    );
    expect(output).not.toMatch(SECRET_REPLACEMENT);
  });

  it('names a workflow that another Worker owns', () => {
    const output = message([
      '▲  The following workflow(s) already exist and belong to different workers:',
      '│    - "void-x-jobs" (currently belongs to "someone-else")',
      '│',
      '│  Deploying will reassign these workflows to "void-x-api". Workflow names must be unique per account. If this reassignment is unintended, rename the workflow(s) in your Wrangler config file.',
    ]);
    expect(output).toBe(
      'platform: The Cloudflare CLI did not upload void-x-api: The following workflow(s) already exist and belong to different workers: - "void-x-jobs" (currently belongs to "someone-else"). Another Worker owns this workflow. Delete the workflow, or rename it in the configuration of that Worker. Then run the command again.',
    );
    expect(output).not.toMatch(/outside Void|--strict|Wrangler|reassign/);
  });

  it('names each workflow that other Workers own', () => {
    expect(
      message([
        '▲  The following workflow(s) already exist and belong to different workers:',
        '│    - "void-x-jobs" (currently belongs to "someone-else")',
        '│    - "void-x-cleanup" (currently belongs to "another-worker")',
        '│',
        '│  Deploying will reassign these workflows to "void-x-api".',
      ]),
    ).toBe(
      'platform: The Cloudflare CLI did not upload void-x-api: The following workflow(s) already exist and belong to different workers: - "void-x-jobs" (currently belongs to "someone-else") - "void-x-cleanup" (currently belongs to "another-worker"). Other Workers own these workflows. Delete each workflow, or rename it in the configuration of the Worker that owns it. Then run the command again.',
    );
  });

  it('does not guess the cause of a conflict that it does not know', () => {
    expect(() => upload(['▲  Something else needs an answer.'])).toThrow(
      `platform: The Cloudflare CLI did not upload void-x-api.${CONFLICT_ADVICE}`,
    );
    expect(() => upload(['▲  Something else needs an answer.'])).not.toThrow(
      /outside Void|Something else/,
    );
  });
});

it('reports structured provider errors when stderr is empty using existing credential redaction', () => {
  expect(() =>
    assertCleanPlatformWrangler(
      {
        status: 1,
        stdout: 'env.PRIVATE_VALUE: "do-not-echo"',
        stderr: '',
        errors: [{ code: 10000, message: 'Invalid Authorization: Bearer synthetic-token' }],
      },
      'upload test-worker',
    ),
  ).toThrow(
    'platform: Cloudflare failed to upload test-worker (Invalid Authorization: Bearer [redacted]).',
  );
});

it('replaces the Analytics Engine APIError token advice with account activation and recovery steps', () => {
  const accountId = '0123456789abcdef0123456789abcdef';
  const dashboard = `https://dash.cloudflare.com/${accountId}/workers/analytics-engine`;
  // The provider appended token advice to this account-activation error on Workers Free.
  const message = `You need to enable Analytics Engine. Head to the Cloudflare Dashboard to enable: ${dashboard} [code: 10089]`;
  const upload = () =>
    assertCleanPlatformWrangler(
      {
        status: 1,
        stdout: '',
        stderr: `\n┌ APIError\n│ [code: 10089] ${message}\n│ 403 Forbidden\n└\n\n→ Check your API token permissions\n`,
        errorCode: 10089,
        errors: [{ code: 10089, message }],
      },
      'bootstrap void-team-tail',
      accountId,
    );
  expect(upload).toThrow(
    'platform: Cloudflare could not bootstrap void-team-tail: Analytics Engine is not enabled for this account (code 10089). ' +
      `Open ${dashboard}, then select Enable. ` +
      'Analytics Engine is available on Workers Free. After enabling it, use the printed recovery command if one is shown; otherwise retry this command. ' +
      'If Enable is unavailable, see https://void.cloud/guide/platform/installation/prerequisites#if-cloudflare-rejects-analytics-engine.',
  );
  expect(upload).not.toThrow(/API token|403 Forbidden|Wrangler/);
});

it('explains how to select the account when only a structured Analytics Engine error is available', () => {
  expect(() =>
    assertCleanPlatformWrangler(
      {
        status: 1,
        stdout: '',
        stderr: '',
        errors: [{ code: 10089, message: 'You need to enable Analytics Engine.' }],
      },
      'bootstrap void-team-tail',
    ),
  ).toThrow(
    'Open https://dash.cloudflare.com/, select your account, and open Analytics Engine, then select Enable.',
  );
});

it.each(['[code: 10089]', '[10089]'])(
  'recognizes a legacy Analytics Engine diagnostic with %s when no structured code is available',
  (code) => {
    expect(() =>
      assertCleanPlatformWrangler(
        { status: 1, stdout: '', stderr: `You need to enable Analytics Engine. ${code}` },
        'bootstrap void-team-tail',
      ),
    ).toThrow('Analytics Engine is not enabled for this account (code 10089).');
  },
);

it.each([
  { errorCode: 10000, errors: undefined },
  { errorCode: undefined, errors: [{ code: 12345, message: 'Unknown provider failure' }] },
])('preserves other structured provider errors and their token advice: %j', (codes) => {
  const diagnostic =
    'The request failed. Check your API token permissions. Previous attempt: [code: 10089]';
  expect(() =>
    assertCleanPlatformWrangler(
      { status: 1, stdout: '', stderr: diagnostic, ...codes },
      'upload test-worker',
    ),
  ).toThrow(`platform: Cloudflare failed to upload test-worker (${diagnostic}).`);
});

it('retains the exit status when stdout contains only binding values', () => {
  expect(() =>
    assertCleanPlatformWrangler(
      { status: 1, stdout: 'env.PRIVATE_VALUE: "do-not-echo"', stderr: '' },
      'upload test-worker',
    ),
  ).toThrow('platform: Cloudflare failed to upload test-worker (exit 1).');
});
