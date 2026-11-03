import { describe, it, expect } from 'vite-plus/test';
// The tail worker owns the `void_logs` row shape and the script-name split.
// Import its real implementation so the two cannot drift apart silently — a
// "keep these in sync" comment does not hold, an assertion does.
import { parseScriptName } from '../../../tail/src/index.ts';
import type { Env } from '../../src/env.ts';
import { recordPlatformLog, splitWorkerName, truncateUtf8 } from '../../src/metering.ts';

function createMockEnv(): { env: Env; writes: Array<unknown> } {
  const writes: Array<unknown> = [];
  const env = {
    LOGS: {
      writeDataPoint: (data: unknown) => writes.push(data),
    },
  } as unknown as Env;
  return { env, writes };
}

type DataPoint = {
  indexes: Array<string>;
  blobs: Array<string>;
  doubles: Array<number>;
};

function writePlatformLog(overrides: Partial<Parameters<typeof recordPlatformLog>[1]> = {}): {
  dp: DataPoint;
  writes: Array<unknown>;
} {
  const { env, writes } = createMockEnv();
  recordPlatformLog(env, {
    workerName: 'user-my-app-dpl_abc123',
    method: 'GET',
    url: 'https://my-app.void.app/slow',
    status: 503,
    timeoutMs: 10000,
    ...overrides,
  });
  return { dp: writes[0] as DataPoint, writes };
}

describe('splitWorkerName', () => {
  it('splits a versioned worker name into the project key and deploy id', () => {
    expect(splitWorkerName('user-my-app-dpl_abc123')).toEqual({
      projectKey: 'user-my-app',
      deployId: 'dpl_abc123',
    });
  });

  it('keeps a legacy unversioned name whole and leaves the deploy id empty', () => {
    expect(splitWorkerName('user-my-app')).toEqual({
      projectKey: 'user-my-app',
      deployId: '',
    });
  });

  it('splits on the LAST -dpl_ so a slug containing it still resolves', () => {
    expect(splitWorkerName('user-dpl_-thing-dpl_zz9')).toEqual({
      projectKey: 'user-dpl_-thing',
      deployId: 'dpl_zz9',
    });
  });

  it('returns null for a name dispatch must never attribute to a project', () => {
    expect(splitWorkerName('')).toBeNull();
    expect(splitWorkerName('void-dispatch')).toBeNull();
  });

  // The whole feature rests on writing the SAME `index1` the tail worker writes.
  // If these ever disagree, the row lands under a key `GET /projects/:id/logs`
  // cannot select, and the user sees nothing — the exact bug this fixes.
  it('agrees with the tail worker for every user script name', () => {
    const names = [
      'user-my-app-dpl_abc123',
      'user-my-app',
      'user-a-dpl_1',
      'user-dpl_-thing-dpl_zz9',
      'user-registry-bridge-dpl_8hgy40zgcpmw',
    ];
    for (const name of names) {
      expect(splitWorkerName(name)).toEqual(parseScriptName(name));
    }
  });
});

describe('recordPlatformLog', () => {
  it('attributes the row to the project key the logs read path queries', () => {
    const { dp } = writePlatformLog();
    expect(dp.indexes).toEqual(['user-my-app']);
  });

  it('writes the deploy id into blob7 so a --deployment filter still matches', () => {
    const { dp } = writePlatformLog();
    expect(dp.blobs[6]).toBe('dpl_abc123');
  });

  it('writes the seven-blob two-double shape the tail worker writes', () => {
    const { dp } = writePlatformLog();

    expect(dp.blobs).toHaveLength(7);
    expect(dp.doubles).toHaveLength(2);
    expect(dp.blobs[0]).toBe('canceled');
    expect(JSON.parse(dp.blobs[2])).toEqual([]);
    expect(dp.blobs[3]).toBe('https://my-app.void.app/slow');
    expect(dp.blobs[4]).toBe('GET');
    expect(dp.blobs[5]).toBe('503');
    expect(dp.doubles[1]).toBe(503);
  });

  it('carries one error-level line naming the budget and the method and path', () => {
    const { dp } = writePlatformLog();
    const logs = JSON.parse(dp.blobs[1]) as Array<{
      level: string;
      message: Array<string>;
      timestamp: number;
    }>;

    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('error');
    expect(typeof logs[0].timestamp).toBe('number');

    const text = logs[0].message.join(' ');
    expect(text).toContain('10000');
    expect(text).toContain('GET /slow');
    expect(text).toContain('503');
  });

  it('reports the real budget when DISPATCH_TIMEOUT_MS overrides the default', () => {
    const { dp } = writePlatformLog({ timeoutMs: 2500 });
    const logs = JSON.parse(dp.blobs[1]) as Array<{ message: Array<string> }>;
    expect(logs[0].message.join(' ')).toContain('2500');
  });

  // Both the SQL predicate in `GET /projects/:id/logs` and the CLI's
  // client-side pass must keep this row under `--level error`.
  it('satisfies the server-side --level error predicate', () => {
    const { dp } = writePlatformLog();
    const [outcome, logData, exceptionData, , , statusCode] = dp.blobs;

    const matches =
      outcome !== 'ok' ||
      exceptionData !== '[]' ||
      logData.includes('"level":"error"') ||
      statusCode.startsWith('5');

    expect(matches).toBe(true);
  });

  it('is written to the logs dataset, never to the requests dataset', () => {
    const writes: Array<unknown> = [];
    const requestWrites: Array<unknown> = [];
    const env = {
      LOGS: { writeDataPoint: (d: unknown) => writes.push(d) },
      ANALYTICS: { writeDataPoint: (d: unknown) => requestWrites.push(d) },
    } as unknown as Env;

    recordPlatformLog(env, {
      workerName: 'user-my-app-dpl_abc123',
      method: 'GET',
      url: 'https://my-app.void.app/slow',
      status: 503,
      timeoutMs: 10000,
    });

    expect(writes).toHaveLength(1);
    expect(requestWrites).toHaveLength(0);
  });

  it('writes nothing when the routing entry carries no worker name', () => {
    const { writes } = writePlatformLog({ workerName: undefined });
    expect(writes).toHaveLength(0);
  });

  // A log write is best effort. It must never convert the 503 it is explaining
  // into an uncaught throw, which the runtime would surface as a 500.
  it('swallows a failing write instead of throwing into the 503 path', () => {
    const env = {
      LOGS: {
        writeDataPoint: () => {
          throw new Error('binding unavailable');
        },
      },
    } as unknown as Env;

    expect(() =>
      recordPlatformLog(env, {
        workerName: 'user-my-app-dpl_abc123',
        method: 'GET',
        url: 'https://my-app.void.app/slow',
        status: 503,
        timeoutMs: 10000,
      }),
    ).not.toThrow();
  });

  it('swallows a missing binding instead of throwing into the 503 path', () => {
    const env = {} as unknown as Env;

    expect(() =>
      recordPlatformLog(env, {
        workerName: 'user-my-app-dpl_abc123',
        method: 'GET',
        url: 'https://my-app.void.app/slow',
        status: 503,
        timeoutMs: 10000,
      }),
    ).not.toThrow();
  });
});

describe('recordPlatformLog with minimal runtime logs', () => {
  function writeMinimal(): DataPoint {
    const writes: Array<unknown> = [];
    const env = {
      LOGS: { writeDataPoint: (d: unknown) => writes.push(d) },
      PLATFORM_RUNTIME_LOGS: 'minimal',
    } as unknown as Env;
    recordPlatformLog(env, {
      workerName: 'user-my-app-dpl_abc123',
      method: 'GET',
      url: 'https://my-app.void.app/private/path?token=secret',
      status: 503,
      timeoutMs: 10000,
    });
    expect(writes).toHaveLength(1);
    return writes[0] as DataPoint;
  }

  it('keeps the request path and query out of every blob', () => {
    const dp = writeMinimal();
    expect(dp.blobs[3]).toBe('');
    for (const blob of dp.blobs) {
      expect(blob).not.toContain('/private');
      expect(blob).not.toContain('token');
      expect(blob).not.toContain('my-app.void.app');
    }
  });

  it('still explains the timeout with the method, budget and status', () => {
    const dp = writeMinimal();
    const logs = JSON.parse(dp.blobs[1]) as Array<{ level: string; message: Array<string> }>;
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('error');
    const text = logs[0].message.join(' ');
    expect(text).toContain('10000');
    expect(text).toContain('GET was cut short');
    expect(text).toContain('503');
  });

  it('keeps the row shape and the --level error match', () => {
    const dp = writeMinimal();
    const [outcome, logData, exceptionData, , method, statusCode, deployId] = dp.blobs;
    expect(dp.indexes).toEqual(['user-my-app']);
    expect(dp.blobs).toHaveLength(7);
    expect(outcome).toBe('canceled');
    expect(JSON.parse(exceptionData)).toEqual([]);
    expect(method).toBe('GET');
    expect(statusCode).toBe('503');
    expect(deployId).toBe('dpl_abc123');
    expect(dp.doubles[1]).toBe(503);
    expect(logData.includes('"level":"error"')).toBe(true);
  });
});

// Analytics Engine caps the SUM of a data point's blobs at 16 KB (raised from
// 5 KB in June 2025 — `void_logs` holds rows of 13,695 bytes today, which
// proves the higher cap is live). There is NO per-blob limit. A data point over
// the cap is dropped, and `recordPlatformLog` swallows the failure by design,
// so an unbounded field would silently lose the very row this feature adds.
//
// The exposure is real, not theoretical: the longest URL already recorded in
// `void_logs` is 6,703 bytes, and this row would carry it twice — once raw in
// blob4 and once as the pathname inside the blob2 message.
describe('recordPlatformLog blob bounds', () => {
  const encoder = new TextEncoder();

  function totalBlobBytes(dp: DataPoint): number {
    return dp.blobs.reduce((sum, b) => sum + encoder.encode(b).length, 0);
  }

  it('keeps a pathological URL far inside the 16 KB blob budget', () => {
    const url = `https://my-app.void.app/${'a'.repeat(64_000)}`;
    const { dp } = writePlatformLog({ url });

    expect(totalBlobBytes(dp)).toBeLessThan(4096);
  });

  it('still writes the row rather than dropping it', () => {
    const url = `https://my-app.void.app/${'a'.repeat(64_000)}`;
    const { dp, writes } = writePlatformLog({ url });

    expect(writes).toHaveLength(1);
    const logs = JSON.parse(dp.blobs[1]) as Array<{ message: Array<string> }>;
    expect(logs[0].message.join(' ')).toContain('did not respond within');
  });

  it('marks a truncated URL so the reader knows it was cut', () => {
    const url = `https://my-app.void.app/${'a'.repeat(64_000)}`;
    const { dp } = writePlatformLog({ url });

    expect(dp.blobs[3].endsWith('…')).toBe(true);
    expect(encoder.encode(dp.blobs[3]).length).toBeLessThanOrEqual(2048);
  });

  it('leaves an ordinary URL untouched', () => {
    const url = 'https://my-app.void.app/docs/guide/usage/linter/rules/react/rules-of-hooks';
    const { dp } = writePlatformLog({ url });

    expect(dp.blobs[3]).toBe(url);
    expect(dp.blobs[3]).not.toContain('…');
  });

  // A byte budget must count the bytes that go on the wire, and it must never
  // cut a multi-byte character in half — a split sequence decodes to U+FFFD,
  // which is itself 3 bytes and would push the field back over its budget.
  it('truncates multi-byte text on a character boundary', () => {
    const url = `https://my-app.void.app/${'漢'.repeat(4000)}`;
    const { dp } = writePlatformLog({ url });

    const bytes = encoder.encode(dp.blobs[3]).length;
    expect(bytes).toBeLessThanOrEqual(2048);
    expect(dp.blobs[3]).not.toContain('�');
    // Every retained glyph survived whole.
    expect(dp.blobs[3].endsWith('漢…')).toBe(true);
  });

  it('bounds the message pathname independently of the raw URL blob', () => {
    const url = `https://my-app.void.app/${'a'.repeat(64_000)}`;
    const { dp } = writePlatformLog({ url });

    expect(encoder.encode(dp.blobs[1]).length).toBeLessThanOrEqual(1400);
  });

  // `index1` is the read key. Truncating it would produce a row that
  // `GET /projects/:id/logs` can never select — worse than a dropped row. It is
  // bounded upstream by the project slug, and the tail worker writes it whole.
  it('never truncates the project key', () => {
    const { dp } = writePlatformLog({ workerName: `user-${'s'.repeat(300)}-dpl_abc123` });

    expect(dp.indexes[0]).toBe(`user-${'s'.repeat(300)}`);
  });
});

describe('truncateUtf8', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  it('returns a value already inside the budget unchanged', () => {
    expect(truncateUtf8('abcdef', 6)).toBe('abcdef');
    expect(truncateUtf8('漢漢', 6)).toBe('漢漢');
  });

  it('cuts ASCII to exactly the budget, ellipsis included', () => {
    expect(truncateUtf8('abcdef', 5)).toBe('ab…');
    expect(bytes(truncateUtf8('abcdef', 5))).toBe(5);
  });

  // Regression: an earlier walk-back dropped a whole character even when the
  // cut already landed on a boundary, losing content for no reason.
  it('keeps every character that fits when the cut lands on a boundary', () => {
    // '漢漢漢' is 9 bytes; a 6-byte budget holds exactly one plus the ellipsis.
    expect(truncateUtf8('漢漢漢', 6)).toBe('漢…');
    expect(bytes(truncateUtf8('漢漢漢', 6))).toBe(6);
  });

  it('never emits a replacement character when cutting mid-sequence', () => {
    for (let budget = 4; budget <= 40; budget++) {
      const out = truncateUtf8('漢字テスト'.repeat(4), budget);
      expect(out).not.toContain('�');
      expect(bytes(out)).toBeLessThanOrEqual(budget);
    }
  });

  it('handles four-byte characters', () => {
    for (let budget = 4; budget <= 30; budget++) {
      const out = truncateUtf8('😀😀😀😀😀', budget);
      expect(out).not.toContain('�');
      expect(bytes(out)).toBeLessThanOrEqual(budget);
    }
  });

  it('yields an empty string when the budget cannot hold the ellipsis', () => {
    expect(truncateUtf8('abcdef', 2)).toBe('');
  });
});
