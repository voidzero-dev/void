import { describe, it, expect } from 'vite-plus/test';
import worker, { buildLogDataPoint } from '../src/index.ts';

const parsed = { projectKey: 'user-my-app', deployId: 'dpl_abc123' };

function fetchTrace(): TraceItem {
  return {
    scriptName: 'user-my-app-dpl_abc123',
    outcome: 'exception',
    eventTimestamp: 1_700_000_000_000,
    event: {
      request: {
        url: 'https://my-app.void.app/account?token=secret',
        method: 'POST',
        headers: { 'cf-ray': '8f1d2c3b4a5e6f70-SJC' },
      },
      response: { status: 500 },
    },
    logs: [
      { level: 'log', timestamp: 1, message: ['user email', 'a@b.c'] },
      { level: 'error', timestamp: 2, message: ['failed for /account?token=secret'] },
    ],
    exceptions: [{ name: 'TypeError', timestamp: 3, message: 'bad token secret', stack: 'at x' }],
    diagnosticsChannelEvents: [],
    scriptTags: [],
  } as unknown as TraceItem;
}

describe('buildLogDataPoint', () => {
  it('writes the full row unchanged by default', () => {
    const event = fetchTrace();
    expect(buildLogDataPoint(event, parsed)).toEqual({
      indexes: ['user-my-app'],
      blobs: [
        'exception',
        JSON.stringify(event.logs),
        JSON.stringify(event.exceptions),
        'https://my-app.void.app/account?token=secret',
        'POST',
        '500',
        'dpl_abc123',
      ],
      doubles: [1_700_000_000_000, 500],
    });
  });

  it('drops the URL and all message text in minimal mode', () => {
    const dp = buildLogDataPoint(fetchTrace(), parsed, 'minimal');
    const blobs = dp.blobs as Array<string>;

    expect(dp.indexes).toEqual(['user-my-app']);
    expect(blobs[0]).toBe('exception');
    expect(blobs[3]).toBe('');
    expect(blobs.slice(4)).toEqual(['POST', '500', 'dpl_abc123', '8f1d2c3b4a5e6f70-SJC']);
    expect(dp.doubles).toEqual([1_700_000_000_000, 500]);
    expect(JSON.parse(blobs[1])).toEqual([
      { level: 'log', timestamp: 1, message: [] },
      { level: 'error', timestamp: 2, message: [] },
    ]);
    expect(JSON.parse(blobs[2])).toEqual([{ name: 'TypeError', timestamp: 3, message: '' }]);
    for (const blob of blobs) {
      expect(blob).not.toContain('secret');
      expect(blob).not.toContain('/account');
      expect(blob).not.toContain('a@b.c');
    }
  });

  it('keeps the level text the --level error filter looks for', () => {
    const dp = buildLogDataPoint(fetchTrace(), parsed, 'minimal');
    expect((dp.blobs as Array<string>)[1]).toContain('"level":"error"');
  });

  it('writes valid empty arrays when the event has no logs or exceptions', () => {
    const event = {
      ...fetchTrace(),
      event: null,
      logs: undefined,
      exceptions: undefined,
    } as unknown as TraceItem;
    const blobs = buildLogDataPoint(event, parsed, 'minimal').blobs as Array<string>;

    expect(JSON.parse(blobs[1])).toEqual([]);
    expect(JSON.parse(blobs[2])).toEqual([]);
    expect(blobs[3]).toBe('');
    expect(blobs[7]).toBe('');
  });

  it('keeps two requests in the same millisecond apart in minimal mode', () => {
    const other = fetchTrace() as unknown as {
      event: { request: { url: string; headers: Record<string, string> } };
    };
    other.event.request.url = 'https://my-app.void.app/other';
    other.event.request.headers = { 'cf-ray': '8f1d2c3b4a5e6f71-SJC' };
    expect(buildLogDataPoint(other as unknown as TraceItem, parsed, 'minimal')).not.toEqual(
      buildLogDataPoint(fetchTrace(), parsed, 'minimal'),
    );
  });
});

describe('tail handler', () => {
  async function run(env: Record<string, unknown>) {
    const writes: Array<AnalyticsEngineDataPoint> = [];
    await worker.tail([fetchTrace()], {
      ANALYTICS: { writeDataPoint: (dp: AnalyticsEngineDataPoint) => writes.push(dp) },
      ...env,
    } as never);
    return writes;
  }

  it('writes the full row when the setting is absent', async () => {
    const [dp] = await run({});
    expect((dp.blobs as Array<string>)[3]).toBe('https://my-app.void.app/account?token=secret');
  });

  it('writes the minimal row when PLATFORM_RUNTIME_LOGS is minimal', async () => {
    const [dp] = await run({ PLATFORM_RUNTIME_LOGS: 'minimal' });
    expect(dp).toEqual(buildLogDataPoint(fetchTrace(), parsed, 'minimal'));
    expect(JSON.stringify(dp)).not.toContain('secret');
  });
});
