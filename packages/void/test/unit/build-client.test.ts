import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformClient } from '../../src/cli/client.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = withPlatformDiscovery(fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

const apiUrl = 'https://api.test';
const token = 'auth-token-x';
const projectId = 'proj_test';

function makeClient(): PlatformClient {
  return new PlatformClient(token, { apiUrl });
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('PlatformClient.listBuilds', () => {
  it('GETs /builds with the limit param and unwraps { builds }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ builds: [{ id: 'b1' }, { id: 'b2' }] }));
    const result = await makeClient().listBuilds(projectId, 5);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/projects/proj_test/builds');
    expect(parsed.searchParams.get('limit')).toBe('5');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer auth-token-x' });
    expect(result.map((b) => b.id)).toEqual(['b1', 'b2']);
  });
});

describe('PlatformClient.getBuildLogs', () => {
  it('GETs /builds/:id/logs with since and returns the envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        lines: [{ seq: 1, line: 'a', stream: 'stdout', ts: 1 }],
        lastSeq: 1,
        status: 'building',
        terminal: false,
        external: null,
      }),
    );
    const result = await makeClient().getBuildLogs(projectId, 'b1', 0);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/projects/proj_test/builds/b1/logs');
    expect(parsed.searchParams.get('since')).toBe('0');
    expect(result.lastSeq).toBe(1);
    expect(result.terminal).toBe(false);
    expect(result.lines[0].line).toBe('a');
  });
});
