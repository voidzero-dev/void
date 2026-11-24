import { describe, expect, test } from 'vite-plus/test';
import {
  LAST_FAILURE_PATH,
  readLastFailure,
  stopSince,
} from '../../src/runner/engines/proxy-failure.ts';

const answer =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    Response.json(body, { status });

describe('readLastFailure', () => {
  test('reads the proxy answer from the origin of the model URL', async () => {
    let url = '';
    const doFetch = (async (input: string | URL | Request) => {
      url = String(input);
      return Response.json({ failure: { reason: 'credits', httpStatus: 402, at: 7 } });
    }) as typeof fetch;
    expect(await readLastFailure('http://model.void.internal/v1', doFetch)).toEqual({
      reason: 'credits',
      httpStatus: 402,
      at: 7,
    });
    expect(url).toBe(`http://model.void.internal${LAST_FAILURE_PATH}`);
  });

  test('null for no failure, a bad answer, an error status or a network error', async () => {
    expect(await readLastFailure('http://m', answer({ failure: null }))).toBeNull();
    expect(await readLastFailure('http://m', answer({ failure: { reason: 1 } }))).toBeNull();
    expect(await readLastFailure('http://m', answer({}, 500))).toBeNull();
    expect(
      await readLastFailure('http://m', async () => {
        throw new Error('down');
      }),
    ).toBeNull();
  });
});

describe('stopSince', () => {
  const stop = { reason: 'tokens', httpStatus: 429, at: 5 };
  test('a failure that is new since the session started is the stop', () => {
    expect(stopSince(null, stop)).toEqual({ httpStatus: 429, reason: 'tokens' });
    expect(stopSince({ ...stop, at: 4 }, stop)).toEqual({ httpStatus: 429, reason: 'tokens' });
  });

  test('the same failure as before, or none, is not', () => {
    expect(stopSince(stop, stop)).toBeNull();
    expect(stopSince(stop, null)).toBeNull();
  });

  test('a failure that is not a stop keeps its status but names no stop', () => {
    expect(stopSince(null, { reason: 'upstream', httpStatus: 502, at: 1 })).toEqual({
      httpStatus: 502,
      reason: null,
    });
  });
});
