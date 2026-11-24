import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vite-plus/test';
import { runSelfTest, suspiciousEnvNames } from '../../src/runner/self-test.ts';
import { startFakeModel } from '../fake-model/server.ts';
import type { FakeModel } from '../fake-model/server.ts';

const MAIN = fileURLToPath(new URL('../../src/runner/main.ts', import.meta.url));

let model: FakeModel | undefined;
afterEach(async () => {
  await model?.close();
  model = undefined;
});

/** A fetch that plays the controller's intercepts: the model route answers, all else is denied. */
function interceptedFetch(
  answers: Record<string, () => Response | Promise<Response>>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const answer = answers[url];
    if (!answer) {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }
    return answer();
  }) as typeof fetch;
}

describe('runSelfTest', () => {
  test('passes when the model route answers and every egress target is blocked', async () => {
    const report = await runSelfTest({
      baseUrl: 'http://model.void.internal',
      uid: 10_001,
      env: { PATH: '/usr/bin', HOME: '/home/scanner' },
      fetch: interceptedFetch({
        'http://model.void.internal/v1/self-test': () => Response.json({ probe: 'pr_abc' }),
        'http://example.com/': () => new Response('egress denied: example.com', { status: 403 }),
      }),
    });
    expect(report.model).toMatchObject({ ok: true, status: 200, probe: 'pr_abc' });
    expect(report.uid).toBe(10_001);
    expect(report.envSuspicious).toEqual([]);
    expect(Object.values(report.egress).every((result) => result.blocked)).toBe(true);
    expect(report.egress.httpExample).toMatchObject({ blocked: true, status: 403 });
    expect(report.egress.httpsExample).toMatchObject({ blocked: true, error: 'ECONNREFUSED' });
  });

  test('a target that answers with anything but the deny handler is not blocked', async () => {
    const report = await runSelfTest({
      targets: { open: 'https://example.com/', fake: 'http://example.org/' },
      fetch: interceptedFetch({
        'https://example.com/': () => new Response('<html>example</html>'),
        // A 403 from the internet is still the internet.
        'http://example.org/': () => new Response('forbidden', { status: 403 }),
      }),
    });
    expect(report.egress.open).toMatchObject({ blocked: false, status: 200 });
    expect(report.egress.fake).toMatchObject({ blocked: false, status: 403 });
    expect(report.model.ok).toBe(false);
  });

  test('a hung request counts as blocked after the timeout', async () => {
    const report = await runSelfTest({
      targets: { hang: 'http://example.com/' },
      timeoutMs: 50,
      fetch: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as typeof fetch,
    });
    expect(report.egress.hang).toMatchObject({ blocked: true, error: 'TimeoutError' });
  });

  test('lists credential-like env names, never their values', () => {
    expect(
      suspiciousEnvNames({
        PATH: '/bin',
        CLOUDFLARE_APPLICATION_ID: 'app',
        AI_GATEWAY_TOKEN: 'secret-value',
        aws_secret_access_key: 'x',
      }),
    ).toEqual(['AI_GATEWAY_TOKEN', 'aws_secret_access_key']);
  });
});

describe('runner --self-test', () => {
  test('prints one JSON report and exits 0', async () => {
    model = await startFakeModel([{ json: { probe: 'pr_cli' } }]);
    // Port 9 on loopback: nothing listens, so the target is refused without leaving the machine.
    const child = spawn(
      process.execPath,
      [
        MAIN,
        '--self-test',
        '--model-base-url',
        model.url,
        '--egress-target',
        'http://127.0.0.1:9/',
      ],
      {
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout.trim());
    expect(report).toMatchObject({
      selfTest: 1,
      model: { ok: true, probe: 'pr_cli' },
      egress: { target0: { blocked: true } },
      envSuspicious: [],
    });
    expect(model.requests[0]).toMatchObject({ method: 'POST', path: '/v1/self-test' });
  });
});
