import { beforeEach, expect, it, vi } from 'vite-plus/test';
import { verifyPlatformHealth } from '../../src/cli/platform-installer-health.ts';

const wait = vi.hoisted(() => vi.fn(async (_milliseconds: number) => {}));
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: wait,
}));

beforeEach(() => wait.mockClear());

const api = 'https://api.example.com';
const proxy = 'https://proxy.example.com';
const check = (fetcher: typeof fetch) =>
  verifyPlatformHealth(
    api,
    'installation',
    proxy,
    'apps.example.com',
    '1.2.1',
    2,
    'private-probe',
    fetcher,
  );
const healthy = (url: string) =>
  Response.json(
    url.endsWith('/.well-known/void-platform')
      ? { installationId: 'installation', platformVersion: '1.2.1', usageProtocolVersion: 2 }
      : { ok: true },
  );

it('retries a transient transport failure without repeating successful health probes', async () => {
  const calls: Array<string> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(new Headers(init?.headers).get('X-Void-Platform-Probe')).toBe('private-probe');
    expect(init?.redirect).toBe('manual');
    if (url === `${proxy}/health` && calls.filter((value) => value === url).length === 1) {
      throw new TypeError('fetch failed');
    }
    return healthy(url);
  }) as typeof fetch;
  await expect(check(fetcher)).resolves.toBeUndefined();
  expect(calls.filter((url) => url === `${proxy}/health`)).toHaveLength(2);
  expect(calls.filter((url) => url === `${api}/health`)).toHaveLength(1);
  expect(wait.mock.calls).toEqual([[250]]);
});

it('identifies the unreachable endpoint after bounded transport retries', async () => {
  const failure = new TypeError('fetch failed');
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${proxy}/health`) {
      throw failure;
    }
    return healthy(url);
  }) as typeof fetch;
  const error = await check(fetcher).catch((value: unknown) => value);
  expect(error).toMatchObject({
    message: `platform: Health check could not reach ${proxy}/health after 3 attempts.`,
    cause: failure,
  });
  expect(String(error)).not.toContain('private-probe');
  expect(wait.mock.calls).toEqual([[250], [500]]);
});

it('does not retry HTTP failures or follow an authentication redirect', async () => {
  const fetcher = vi.fn(async (input: string | URL | Request) =>
    String(input) === `${api}/health`
      ? new Response(null, { status: 302, headers: { Location: 'https://login.example.com' } })
      : healthy(String(input)),
  ) as typeof fetch;
  await expect(check(fetcher)).rejects.toThrow(`Health check failed at ${api}/health (HTTP 302)`);
  expect(wait).not.toHaveBeenCalled();
});
