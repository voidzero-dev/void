import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { importD1SqlFile } from '../../src/cli/cf-d1-import.ts';
import { temporaryDirectory } from '../helpers/cloudflare-operation-process.ts';

const sql = "INSERT INTO messages VALUES ('synthetic');\n";
const etag = createHash('md5').update(sql).digest('hex');
const headers = { Authorization: 'Bearer synthetic-token' };
const endpoint = 'https://api.example.com/import';

function fixture() {
  const file = join(temporaryDirectory('void-d1-import-'), 'input.sql');
  writeFileSync(file, sql);
  return { file, headers, endpoint };
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
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
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
