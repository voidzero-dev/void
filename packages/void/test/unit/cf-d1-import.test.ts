import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { d1ImportUploadTimeoutMs, importD1SqlFile } from '../../src/cli/cf-d1-import.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';
import { temporaryDirectory } from '../helpers/cloudflare-operation-process.ts';

const sql = "INSERT INTO messages VALUES ('synthetic');\n";
const etag = createHash('md5').update(sql).digest('hex');
const headers = { Authorization: 'Bearer synthetic-token' };
const endpoint = 'https://api.example.com/import';

function fixture() {
  const file = join(temporaryDirectory('void-d1-import-'), 'input.sql');
  writeFileSync(file, sql);
  return { file, headers, endpoint, pollIntervalMs: 0 };
}
function response(result: unknown) {
  return Response.json({ success: true, result });
}

afterEach(() => vi.unstubAllGlobals());

it('resumes an already uploaded import without uploading or ingesting twice', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response({ at_bookmark: 'current', success: true, status: 'active' }))
    .mockResolvedValueOnce(response({ status: 'complete', success: true }));
  vi.stubGlobal('fetch', fetch);
  await importD1SqlFile(fixture());
  expect(fetch.mock.calls.map(([, init]): unknown => JSON.parse(String(init?.body)))).toEqual([
    { action: 'init', etag },
    { action: 'poll', current_bookmark: 'current' },
  ]);
});

it.each([
  {
    stage: 'initial status',
    responses: [response({ status: 'error', error: 'Import unavailable' })],
    error: 'Import unavailable',
  },
  {
    stage: 'init',
    responses: [
      Response.json(
        { success: false, errors: [{ message: 'Permission denied' }] },
        { status: 403 },
      ),
    ],
    error: 'Permission denied',
  },
  {
    stage: 'upload',
    responses: [
      response({ filename: 'input.sql', upload_url: 'https://uploads.example.com/sql' }),
      new Response('', { headers: { etag: 'wrong' } }),
    ],
    error: 'verification',
  },
  {
    stage: 'ingest',
    responses: [
      response({ filename: 'input.sql', upload_url: 'https://uploads.example.com/sql' }),
      new Response('', { headers: { etag } }),
      response({ status: 'error', success: false, error: 'Invalid SQL' }),
    ],
    error: 'Invalid SQL',
  },
  {
    stage: 'poll',
    responses: [
      response({ at_bookmark: 'current', status: 'active' }),
      response({ status: 'error', error: 'Import stopped' }),
    ],
    error: 'Import stopped',
  },
  {
    stage: 'status',
    responses: [
      response({ at_bookmark: 'current', status: 'active' }),
      response({ status: 'complete' }),
    ],
    error: 'invalid D1 import status',
  },
])('fails closed at $stage without resubmitting SQL', async ({ responses, error }) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of responses) {
    fetch.mockResolvedValueOnce(value);
  }
  vi.stubGlobal('fetch', fetch);
  await expect(importD1SqlFile(fixture())).rejects.toThrow(error);
  expect(fetch).toHaveBeenCalledTimes(responses.length);
});

it('rejects non-HTTPS upload URLs without sending SQL or credentials', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
    response({
      filename: 'input.sql',
      upload_url: 'http://uploads.example.com/sql',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(importD1SqlFile(fixture())).rejects.toThrow('insecure');
  expect(fetch).toHaveBeenCalledTimes(1);
});

async function importError(): Promise<Error> {
  const error = await importD1SqlFile(fixture()).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

it('shows the SQL errors and messages D1 reports for a failed ingest', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ at_bookmark: 'current', status: 'active' }))
      .mockResolvedValueOnce(
        response({
          success: true,
          status: 'error',
          at_bookmark: 'current',
          errors: ['no such table: nope: SQLITE_ERROR', { message: 'second error' }],
          messages: ['Processed 1 queries.'],
        }),
      ),
  );
  expect((await importError()).message).toBe(
    'D1 import failed: no such table: nope: SQLITE_ERROR\nsecond error\nProcessed 1 queries.',
  );
});

it('removes terminal escape sequences from D1 import errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      response({
        status: 'error',
        errors: ['\u001b]8;;https://x.example\u0007bad\u001b]8;;\u0007 table\u001b[2K'],
      }),
    ),
  );
  expect((await importError()).message).toBe('D1 import failed: bad table');
});

const uploaded = () => [
  response({ filename: 'input.sql', upload_url: 'https://uploads.example.com/sql' }),
  new Response('', { headers: { etag } }),
];
const unknownOutcome = 'The import may still be running on Cloudflare';

it('bounds each D1 request and the upload instead of the whole import', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of [
    ...uploaded(),
    response({ at_bookmark: 'current', status: 'active' }),
    response({ status: 'complete', success: true }),
  ]) {
    fetch.mockResolvedValueOnce(value);
  }
  vi.stubGlobal('fetch', fetch);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  await importD1SqlFile(fixture());
  const signals = fetch.mock.calls.map(([, init]) => init?.signal);
  for (const signal of signals) {
    expect(signal).toBeInstanceOf(AbortSignal);
  }
  expect(new Set(signals).size).toBe(4);
  expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([
    120_000,
    d1ImportUploadTimeoutMs(Buffer.byteLength(sql)),
    120_000,
    120_000,
  ]);
});

it('gives the upload time for a 25 MB file on a slow link', () => {
  // 25 MB at 1 Mbit/s takes 200 seconds, on top of the 2-minute request bound.
  expect(d1ImportUploadTimeoutMs(25 * 1024 * 1024)).toBe(320_000);
  expect(d1ImportUploadTimeoutMs(0)).toBe(120_000);
});

it('keeps a stalled upload a plain failure that names its deadline', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(uploaded()[0])
      .mockRejectedValueOnce(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      ),
  );
  const error = await importError();
  expect(error.message).toBe(
    `D1 import upload did not finish within ${d1ImportUploadTimeoutMs(Buffer.byteLength(sql)) / 1000} seconds.`,
  );
  expect(error.cause).toBeInstanceOf(DOMException);
});

it.each([
  {
    name: 'times out',
    reply: () => Promise.reject(new DOMException('The operation was aborted', 'TimeoutError')),
    cause: 'The operation was aborted.',
  },
  {
    name: 'loses the connection',
    reply: () => Promise.reject(new TypeError('fetch failed')),
    cause: 'fetch failed.',
  },
  {
    name: 'answers with a server error',
    reply: () =>
      Promise.resolve(
        Response.json({ success: false, errors: [{ message: 'Internal' }] }, { status: 502 }),
      ),
    cause: 'D1 import failed (HTTP 502): Internal.',
  },
  {
    name: 'answers with something other than JSON',
    reply: () => Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 })),
    cause: 'is not valid JSON',
  },
])(
  'reports an unknown outcome when init $name, since init starts a cached upload',
  async ({ reply, cause }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(reply);
    vi.stubGlobal('fetch', fetch);
    const { message } = await importError();
    expect(message).toContain(cause);
    expect(message).toContain(unknownOutcome + '.');
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('reports an unknown outcome with the bookmark when a cached import fails after init', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ at_bookmark: 'cached', status: 'active' }))
      .mockRejectedValueOnce(new TypeError('fetch failed')),
  );
  expect((await importError()).message).toContain(`${unknownOutcome} (bookmark cached).`);
});

it('keeps an init that D1 refused a plain failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { success: false, errors: [{ message: 'Permission denied' }] },
          { status: 403 },
        ),
      ),
  );
  expect((await importError()).message).toBe('D1 import failed (HTTP 403): Permission denied');
});

it('keeps an init refused with a non-JSON 4xx a plain failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('<html>Forbidden</html>', { status: 403 })),
  );
  expect((await importError()).message).toBe('D1 import failed (HTTP 403).');
});

it('reports an unknown outcome when init asks for no upload but gives no bookmark', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ status: 'active' })),
  );
  const { message } = await importError();
  expect(message).toContain('invalid D1 import upload.');
  expect(message).toContain(unknownOutcome + '.');
});

it('keeps an upload request without a filename a plain failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ upload_url: 'https://uploads.example.com/sql' })),
  );
  expect((await importError()).message).toBe('Cloudflare returned an invalid D1 import upload.');
});

it('reports an unknown outcome with the bookmark when a poll times out', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ at_bookmark: 'current', status: 'active' }))
      .mockRejectedValueOnce(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      ),
  );
  const error = await importError();
  expect(error.message).toBe(
    'D1 did not report whether the import finished: The operation was aborted due to timeout. ' +
      `${unknownOutcome} (bookmark current). Check the database before running the file again.`,
  );
  expect(error.cause).toBeInstanceOf(DOMException);
});

it('reports an unknown outcome when the ingest request fails', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of uploaded()) {
    fetch.mockResolvedValueOnce(value);
  }
  fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
  vi.stubGlobal('fetch', fetch);
  const { message } = await importError();
  expect(message).toContain('fetch failed.');
  expect(message).toContain(unknownOutcome + '.');
  expect(message).not.toContain('bookmark');
});

it('keeps a D1-reported poll failure a plain failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ at_bookmark: 'current', status: 'active' }))
      .mockResolvedValueOnce(response({ status: 'error', errors: ['UNIQUE constraint failed'] })),
  );
  expect((await importError()).message).toBe('D1 import failed: UNIQUE constraint failed');
});

it('keeps an upload failure a plain failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(uploaded()[0])
      .mockRejectedValueOnce(new TypeError('fetch failed')),
  );
  expect((await importError()).message).toBe('fetch failed');
});
