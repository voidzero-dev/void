import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

const script = resolve(import.meta.dirname, '../scripts/refresh-access-token.mjs');
const jwt = `header.${(Buffer as BufferConstructor).from(JSON.stringify({ exp: 4_102_444_800 })).toString('base64url')}.test`;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'void-dashboard-access-test-'));
  writeFileSync(
    join(root, 'cloudflared'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync('probe.json', JSON.stringify(process.argv.slice(2)));\nconsole.log(${JSON.stringify(jwt)});\n`,
    { mode: 0o700 },
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(contents: string, env: Record<string, string> = {}) {
  writeFileSync(join(root, '.env'), contents);
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: [root, dirname(process.execPath)].join(delimiter),
      ...env,
    },
  });
}

describe('dashboard Access token refresh', () => {
  it('leaves an ordinary self-hosted API alone without Access opt-in', () => {
    const contents = 'API_URL=https://platform.example.com\n';
    expect(run(contents).status).toBe(0);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(contents);
  });

  it('rejects an Access origin that differs from the API destination', () => {
    const contents =
      'API_URL=https://platform.example.com\nCF_ACCESS_APP_URL=https://other.example.com\n';
    expect(run(contents).status).toBe(1);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(contents);
  });

  it('rejects insecure Access configuration before requesting a token', () => {
    expect(
      run('API_URL=http://platform.example.com\nCF_ACCESS_APP_URL=http://platform.example.com\n')
        .status,
    ).toBe(1);
  });

  it('uses an existing service-token pair from .env without refreshing', () => {
    const contents =
      'API_URL=https://platform.example.com\nCF_ACCESS_APP_URL=https://platform.example.com\nCF_ACCESS_CLIENT_ID=test-id\nCF_ACCESS_CLIENT_SECRET=test-secret\n';
    expect(run(contents).status).toBe(0);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(contents);
  });

  it('preserves automatic Void Cloud staging authentication', () => {
    const result = run('API_URL=https://api.staging.void.cloud\n');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('CF_ACCESS_TOKEN=');
  });

  it('refreshes and persists a token for an explicitly selected self-hosted API origin', () => {
    const result = run(
      'API_URL=https://platform.example.com\nCF_ACCESS_APP_URL=https://platform.example.com\n',
    );
    expect(result.status, result.stderr).toBe(0);
    const contents = readFileSync(join(root, '.env'), 'utf8');
    expect(contents).toContain(`CF_ACCESS_TOKEN="${jwt}"`);
    expect(contents).toContain('CF_ACCESS_TOKEN_ORIGIN="https://platform.example.com"');
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
  });

  it('reuses an unexpired file token only for its recorded origin', () => {
    const contents = `API_URL=https://platform.example.com\nCF_ACCESS_APP_URL=https://platform.example.com\nCF_ACCESS_TOKEN=${jwt}\nCF_ACCESS_TOKEN_ORIGIN=https://platform.example.com\n`;
    expect(run(contents).status).toBe(0);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(contents);
    expect(existsSync(join(root, 'probe.json'))).toBe(false);
  });

  it('reacquires credentials when switching from one Access-protected API to another', () => {
    const oldJwt = jwt.replace('header.', 'old.');
    const result = run(
      `API_URL=https://b.example.com\nCF_ACCESS_APP_URL=https://b.example.com\nCF_ACCESS_TOKEN=${oldJwt}\nCF_ACCESS_TOKEN_ORIGIN=https://a.example.com\n`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'probe.json'), 'utf8'))).toEqual([
      'access',
      'token',
      '-app=https://b.example.com',
    ]);
    const contents = readFileSync(join(root, '.env'), 'utf8');
    expect(contents).not.toContain(oldJwt);
    expect(contents).toContain(`CF_ACCESS_TOKEN="${jwt}"`);
    expect(contents).toContain('CF_ACCESS_TOKEN_ORIGIN="https://b.example.com"');
  });

  it('removes old credentials when switching to an unprotected API', () => {
    const result = run(
      `API_URL=https://b.example.com\nCF_ACCESS_TOKEN=${jwt}\nCF_ACCESS_TOKEN_ORIGIN=https://a.example.com\n`,
    );
    expect(result.status, result.stderr).toBe(0);
    const contents = readFileSync(join(root, '.env'), 'utf8');
    expect(contents).not.toContain('CF_ACCESS_TOKEN');
    expect(existsSync(join(root, 'probe.json'))).toBe(false);
  });

  it('reacquires legacy cached tokens that have no recorded origin', () => {
    const result = run(
      `API_URL=https://platform.example.com\nCF_ACCESS_APP_URL=https://platform.example.com\nCF_ACCESS_TOKEN=${jwt}\n`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'probe.json'))).toBe(true);
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain(
      'CF_ACCESS_TOKEN_ORIGIN="https://platform.example.com"',
    );
  });

  it('accepts explicitly provided environment tokens without using stale file credentials', () => {
    const result = run(
      `API_URL=https://b.example.com\nCF_ACCESS_APP_URL=https://b.example.com\nCF_ACCESS_TOKEN=${jwt}\nCF_ACCESS_TOKEN_ORIGIN=https://a.example.com\n`,
      { CF_ACCESS_TOKEN: jwt },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'probe.json'))).toBe(false);
    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain('CF_ACCESS_TOKEN');
  });
});
