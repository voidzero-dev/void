import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformClient, type LogEntry } from '../../src/cli/client.ts';
import { filterLogEntries } from '../../src/cli/logs.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

function entry(partial: Partial<LogEntry>): LogEntry {
  return {
    timestamp: 0,
    outcome: 'ok',
    logs: [],
    exceptions: [],
    url: '',
    method: 'GET',
    status: '200',
    ...partial,
  };
}

const E_OK = entry({});
const E_ERROR_LOG = entry({
  logs: [{ level: 'error', message: ['boom'], timestamp: 0 }],
});
const E_WARN_LOG = entry({
  logs: [{ level: 'warn', message: ['careful'], timestamp: 0 }],
});
const E_INFO_LOG = entry({
  logs: [{ level: 'info', message: ['hello'], timestamp: 0 }],
});
const E_LOG_LOG = entry({
  logs: [{ level: 'log', message: ['plain'], timestamp: 0 }],
});
const E_DEBUG_LOG = entry({
  logs: [{ level: 'debug', message: ['trace'], timestamp: 0 }],
});
const E_EXCEPTION = entry({
  outcome: 'exception',
  exceptions: [{ name: 'TypeError', message: 'x is undefined', timestamp: 0 }],
  logs: [],
});
const E_NON_OK = entry({ outcome: 'canceled' });
const E_MIXED = entry({
  logs: [
    { level: 'error', message: ['websocket failed'], timestamp: 0 },
    { level: 'info', message: ['hello'], timestamp: 0 },
  ],
});

describe('filterLogEntries', () => {
  it('passes through everything when level is undefined and filter is empty', () => {
    const all = [E_OK, E_ERROR_LOG, E_WARN_LOG, E_INFO_LOG, E_DEBUG_LOG];
    expect(filterLogEntries(all, undefined, '')).toEqual(all);
  });

  it("treats --level 'all' the same as no level", () => {
    const all = [E_OK, E_ERROR_LOG, E_WARN_LOG, E_INFO_LOG];
    expect(filterLogEntries(all, 'all', '')).toEqual(all);
  });

  it('--level error matches error log lines, exceptions, and non-ok outcomes', () => {
    const result = filterLogEntries(
      [E_OK, E_ERROR_LOG, E_WARN_LOG, E_EXCEPTION, E_NON_OK],
      'error',
      '',
    );
    expect(result).toEqual([E_ERROR_LOG, E_EXCEPTION, E_NON_OK]);
  });

  it('--level error excludes ok-outcome entries with only non-error logs', () => {
    expect(filterLogEntries([E_INFO_LOG, E_WARN_LOG, E_DEBUG_LOG, E_LOG_LOG], 'error', '')).toEqual(
      [],
    );
  });

  it('--level error matches a 5xx status even when the worker did not throw or log', () => {
    // A returned Response(status:500): outcome ok, no logs, no exceptions.
    const silent500 = entry({ outcome: 'ok', logs: [], exceptions: [], status: '500' });
    expect(filterLogEntries([E_OK, silent500], 'error', '')).toEqual([silent500]);
  });

  it('--level error ignores a non-5xx status with no error signal', () => {
    const ok404 = entry({ outcome: 'ok', logs: [], exceptions: [], status: '404' });
    expect(filterLogEntries([ok404], 'error', '')).toEqual([]);
  });

  it('--level warn matches only warn entries (does not include error)', () => {
    expect(
      filterLogEntries([E_OK, E_ERROR_LOG, E_WARN_LOG, E_INFO_LOG, E_EXCEPTION], 'warn', ''),
    ).toEqual([E_WARN_LOG]);
  });

  it('--level info matches only info entries', () => {
    expect(
      filterLogEntries([E_ERROR_LOG, E_WARN_LOG, E_INFO_LOG, E_DEBUG_LOG], 'info', ''),
    ).toEqual([E_INFO_LOG]);
  });

  it('--level debug matches only debug entries', () => {
    expect(
      filterLogEntries([E_ERROR_LOG, E_WARN_LOG, E_INFO_LOG, E_DEBUG_LOG], 'debug', ''),
    ).toEqual([E_DEBUG_LOG]);
  });

  it('--level log matches only log-level entries (not error, info, etc.)', () => {
    expect(
      filterLogEntries([E_ERROR_LOG, E_WARN_LOG, E_INFO_LOG, E_LOG_LOG, E_DEBUG_LOG], 'log', ''),
    ).toEqual([E_LOG_LOG]);
  });

  it("--level log matches entries whose log line has no level (printEntry renders those as '[log]')", () => {
    const E_NULLISH_LEVEL = entry({
      // Cast covers the user-DTO case where `level` is missing or undefined.
      logs: [
        {
          level: undefined as unknown as string,
          message: ['plain'],
          timestamp: 0,
        },
      ],
    });
    expect(filterLogEntries([E_INFO_LOG, E_NULLISH_LEVEL], 'log', '')).toEqual([E_NULLISH_LEVEL]);
  });

  it('substring filter alone is case-insensitive over messages and exceptions', () => {
    expect(filterLogEntries([E_OK, E_ERROR_LOG, E_WARN_LOG], undefined, 'CAREFUL')).toEqual([
      E_WARN_LOG,
    ]);
    expect(filterLogEntries([E_OK, E_EXCEPTION], undefined, 'TypeError')).toEqual([E_EXCEPTION]);
  });

  it('substring filter "error" matches message text, not the log level', () => {
    const errorWordEntry = entry({
      logs: [{ level: 'info', message: ['this is an error in the message'], timestamp: 0 }],
    });
    const result = filterLogEntries(
      [E_OK, E_ERROR_LOG, E_WARN_LOG, errorWordEntry],
      undefined,
      'error',
    );
    expect(result).toEqual([errorWordEntry]);
  });

  it('--level error AND --filter websocket: ANDs both conditions', () => {
    const result = filterLogEntries([E_OK, E_ERROR_LOG, E_MIXED, E_INFO_LOG], 'error', 'websocket');
    expect(result).toEqual([E_MIXED]);
  });
});

function setFetchMock() {
  const fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () => Response.json({ data: [] }));
  globalThis.fetch = withPlatformDiscovery(fetchMock);
  return fetchMock;
}

/** The API request URL; the platform discovery request never reaches the mock. */
function requestUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error('fetch was not called');
  }
  return String(call[0]);
}

describe('PlatformClient.getLogs URL', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('omits level when not provided', async () => {
    const fetchMock = setFetchMock();
    const client = new PlatformClient('tok', { apiUrl: 'http://localhost:1234' });
    await client.getLogs('proj_1', '1h');

    const url = requestUrl(fetchMock);
    expect(url).toContain('since=1h');
    expect(url).not.toContain('level=');
  });

  it("omits level when level === 'all'", async () => {
    const fetchMock = setFetchMock();
    const client = new PlatformClient('tok', { apiUrl: 'http://localhost:1234' });
    await client.getLogs('proj_1', '1h', 200, undefined, 'all');

    expect(requestUrl(fetchMock)).not.toContain('level=');
  });

  it("appends level=error when level === 'error'", async () => {
    const fetchMock = setFetchMock();
    const client = new PlatformClient('tok', { apiUrl: 'http://localhost:1234' });
    await client.getLogs('proj_1', '1h', 200, undefined, 'error');

    expect(requestUrl(fetchMock)).toContain('level=error');
  });

  it('serializes deploymentId and level together', async () => {
    const fetchMock = setFetchMock();
    const client = new PlatformClient('tok', { apiUrl: 'http://localhost:1234' });
    await client.getLogs('proj_1', '1h', 200, 'dpl_abc', 'warn');

    const url = requestUrl(fetchMock);
    expect(url).toContain('deploymentId=dpl_abc');
    expect(url).toContain('level=warn');
  });

  it('keeps the minimal runtime logs marker from the response', async () => {
    const client = new PlatformClient('tok', { apiUrl: 'http://localhost:1234' });
    globalThis.fetch = withPlatformDiscovery(
      vi.fn(async () => Response.json({ data: [], runtimeLogs: 'minimal' })),
    );
    expect(await client.getLogs('proj_1', '1h')).toEqual({ entries: [], runtimeLogs: 'minimal' });
    setFetchMock();
    expect(await client.getLogs('proj_1', '1h')).toEqual({ entries: [] });
  });
});

describe('PlatformClient.getRequests URL', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('hits the /requests endpoint with since and limit, omitting status by default', async () => {
    const fetchMock = setFetchMock();
    const client = new PlatformClient('tok', { apiUrl: 'http://localhost:1234' });
    await client.getRequests('proj_1', '12h');

    const url = requestUrl(fetchMock);
    expect(url).toContain('/projects/proj_1/requests?');
    expect(url).toContain('since=12h');
    expect(url).toContain('limit=200');
    expect(url).not.toContain('status=');
  });

  it("omits status when status === 'all'", async () => {
    const fetchMock = setFetchMock();
    const client = new PlatformClient('tok', { apiUrl: 'http://localhost:1234' });
    await client.getRequests('proj_1', '1h', 200, 'all');

    expect(requestUrl(fetchMock)).not.toContain('status=');
  });

  it('appends a status class filter', async () => {
    const fetchMock = setFetchMock();
    const client = new PlatformClient('tok', { apiUrl: 'http://localhost:1234' });
    await client.getRequests('proj_1', '1h', 200, '5xx');

    expect(requestUrl(fetchMock)).toContain('status=5xx');
  });
});
