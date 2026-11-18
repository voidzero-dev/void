import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import {
  checkCliVersionOrRespond,
  compareVersions,
  MIN_CLI_VERSION,
} from '../../src/middleware/cli-version.ts';

function makeApp() {
  const app = new Hono();
  app.post('/deploy', async (c) => {
    const reject = checkCliVersionOrRespond(c);
    if (reject) {
      return reject;
    }
    return c.json({ ok: true });
  });
  return app;
}

describe('compareVersions', () => {
  it('returns negative for older versions', () => {
    expect(compareVersions('0.6.9', '0.7.0')).toBeLessThan(0);
    expect(compareVersions('0.7.0', '0.7.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
  });

  it('returns positive for newer versions', () => {
    expect(compareVersions('0.7.1', '0.7.0')).toBeGreaterThan(0);
    expect(compareVersions('0.8.0', '0.7.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('returns 0 for equal versions (ignoring pre-release)', () => {
    expect(compareVersions('0.7.0', '0.7.0')).toBe(0);
    expect(compareVersions('0.7.0-rc.1', '0.7.0')).toBe(0);
  });

  it('accepts SemVer 2.0 build metadata (+suffix)', () => {
    // CI-built CLIs commonly stamp commit SHAs as `1.2.3+sha.abc`.
    // The regex must accept these or the gate would 426 a current CLI.
    expect(compareVersions('1.0.0+build.123', '0.7.0')).toBeGreaterThan(0);
    expect(compareVersions('0.7.0+sha.abcdef', '0.7.0')).toBe(0);
    expect(compareVersions('0.7.0-rc.1+build.456', '0.7.0')).toBe(0);
    expect(compareVersions('0.6.0+build', '0.7.0')).toBeLessThan(0);
  });

  it('returns null for unparseable versions', () => {
    expect(compareVersions('garbage', '0.7.0')).toBeNull();
    expect(compareVersions('0.7', '0.7.0')).toBeNull();
    expect(compareVersions('', '0.7.0')).toBeNull();
  });
});

describe('checkCliVersionOrRespond', () => {
  it('passes through when no CLI version header is set', async () => {
    const res = await makeApp().request('/deploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('passes through when version is exactly MIN_CLI_VERSION', async () => {
    const res = await makeApp().request('/deploy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-cli-version': MIN_CLI_VERSION,
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('passes through when version is newer than MIN_CLI_VERSION', async () => {
    const res = await makeApp().request('/deploy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-cli-version': '99.0.0',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('rejects older version with 426 + cli_outdated', async () => {
    const res = await makeApp().request('/deploy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-cli-version': '0.6.0',
      },
      body: '{}',
    });
    expect(res.status).toBe(426);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('cli_outdated');
    expect(body.minVersion).toBe(MIN_CLI_VERSION);
    expect(body.clientVersion).toBe('0.6.0');
    expect(body.message).toMatch(/below the minimum/i);
    expect(body.message).toMatch(/npm i -g void@latest/);
  });

  it('rejects multipart bodies with 426 (regardless of header)', async () => {
    const res = await makeApp().request('/deploy', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=----example',
      },
      body: '------example\r\nContent-Disposition: form-data; name="x"\r\n\r\nhi\r\n------example--\r\n',
    });
    expect(res.status).toBe(426);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('cli_outdated');
    expect(body.message).toMatch(/multipart/i);
    expect(body.minVersion).toBe(MIN_CLI_VERSION);
  });

  it('matches multipart with case-insensitive content-type', async () => {
    const res = await makeApp().request('/deploy', {
      method: 'POST',
      headers: {
        'content-type': 'Multipart/Form-Data; boundary=x',
      },
      body: '--x--\r\n',
    });
    expect(res.status).toBe(426);
  });

  // Fail closed: anything the regex rejects (non-semver, two-segment, empty
  // string, etc.) is treated as a stale CLI — either a buggy client we should surface
  // or a forged bypass attempt. Pre-release tags like `0.7.0-rc.1` are
  // explicitly allowed by the regex so legitimate CLIs don't hit this.
  describe('rejects malformed version headers (fail closed)', () => {
    it.each([['garbage'], ['0.7'], ['0.7.0.1'], ['v0.7.0'], ['1.x.0'], ['']])(
      'rejects %s with 426',
      async (badVersion) => {
        const res = await makeApp().request('/deploy', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-void-cli-version': badVersion,
          },
          body: '{}',
        });
        expect(res.status).toBe(426);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe('cli_outdated');
        expect(body.message).toMatch(/unrecognized/i);
        expect(body.clientVersion).toBe(badVersion);
      },
    );
  });

  it('accepts pre-release suffixes', async () => {
    const res = await makeApp().request('/deploy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-cli-version': '0.7.0-rc.1',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
});
