import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  createCloudflareProcessRunner,
  decodeCloudflareOperationResult,
} from '../../src/cli/cloudflare-process.ts';

const processResult = (envelope: unknown) => ({
  status: 0,
  stdout: JSON.stringify(envelope),
  stderr: 'Provider diagnostic.',
});

describe('typed Cloudflare process protocol', () => {
  it('allows a full-size base64 Worker source through the parent capture without widening other reads', () => {
    const spawn = vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
      pid: 1,
      output: [],
      status: 0,
      signal: null,
      stdout: JSON.stringify({ operationResult: 1, data: { id: 'version-id' } }),
      stderr: '',
    });
    syncBuiltinESMExports();
    try {
      const runner = createCloudflareProcessRunner({ root: process.cwd() });
      const read = { type: 'versions.view', versionId: 'version-id', workerName: 'app' } as const;
      expect(runner({ ...read, includeSource: true }, { capture: true }).status).toBe(0);
      // Workers allow 64 MiB of source, which grows by a third when base64-encoded.
      const encodedWorkerBytes = Math.ceil((64 * 1024 * 1024 * 4) / 3);
      expect(spawn.mock.calls[0]![2]!.maxBuffer).toBeGreaterThan(encodedWorkerBytes);

      expect(runner(read, { capture: true }).status).toBe(0);
      expect(spawn.mock.calls[1]![2]!.maxBuffer).toBe(32 * 1024 * 1024);
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('keeps structured data separate from human output', () => {
    expect(
      decodeCloudflareOperationResult(
        processResult({ operationResult: 1, data: [{ id: 'resource' }], output: 'Done.\n' }),
      ),
    ).toEqual({
      status: 0,
      stdout: 'Done.\n',
      stderr: 'Provider diagnostic.',
      data: [{ id: 'resource' }],
      errorCode: undefined,
      errors: undefined,
      failure: undefined,
    });
  });

  it('preserves typed provider failure details', () => {
    const value = decodeCloudflareOperationResult({
      ...processResult({
        operationResult: 1,
        errorCode: 10007,
        failure: 'not-found',
        errors: [{ code: 10007, message: 'Worker is absent.' }],
      }),
      status: 1,
    });
    expect(value).toMatchObject({
      status: 1,
      stdout: '',
      errorCode: 10007,
      failure: 'not-found',
      errors: [{ code: 10007, message: 'Worker is absent.' }],
    });
  });

  it.each([
    null,
    [],
    {},
    { operationResult: 2 },
    { operationResult: 1, output: {} },
    { operationResult: 1, errorCode: '10007' },
    { operationResult: 1, errorCode: 0.5 },
    { operationResult: 1, failure: 'unknown' },
    { operationResult: 1, errors: {} },
    { operationResult: 1, errors: [null] },
    { operationResult: 1, errors: [{ message: 3 }] },
    { operationResult: 1, errors: [{ message: 'Bad.', code: '10007' }] },
  ])('fails closed for malformed envelope %j', (envelope) => {
    const value = decodeCloudflareOperationResult(processResult(envelope));
    expect(value.status).toBe(1);
    expect(value.stdout).toBe('');
    expect(value.stderr).toContain('invalid operation response');
    expect(value).not.toHaveProperty('data');
    expect(value).not.toHaveProperty('failure');
  });

  it.each([
    '',
    'Worker Version ID: 11111111-1111-4111-8111-111111111111',
    '[{"id":"legacy-json"}]',
  ])('rejects success without a private envelope', (stdout) => {
    expect(decodeCloudflareOperationResult({ status: 0, stdout, stderr: '' }).status).toBe(1);
  });

  it.each([{ signal: 'SIGTERM' as const }, { error: 'Could not spawn.' }, { status: null }])(
    'never trusts buffered data after a process failure',
    (provenance) => {
      const result = {
        ...processResult({ operationResult: 1, data: [], errorCode: 10007, failure: 'not-found' }),
        ...provenance,
      };
      expect(decodeCloudflareOperationResult(result)).toEqual(result);
      expect(decodeCloudflareOperationResult(result)).not.toHaveProperty('failure');
    },
  );

  it('retains an unsuccessful process diagnostic without fabricating provider data', () => {
    const result = { status: 1, stdout: '', stderr: 'Exited before responding.' };
    expect(decodeCloudflareOperationResult(result)).toEqual(result);
  });
});

it.each([{ signal: 'SIGTERM' }, { error: 'Provider spawn failed.' }])(
  'retains nested provider provenance without trusting its buffered data',
  (provenance) => {
    const result = decodeCloudflareOperationResult(
      processResult({
        operationResult: 1,
        data: [],
        errorCode: 10007,
        failure: 'not-found',
        ...provenance,
      }),
    );
    expect(result.status).toBe(1);
    expect(result).toMatchObject(provenance);
    expect(result).not.toHaveProperty('data');
    expect(result).not.toHaveProperty('failure');
    expect(result).not.toHaveProperty('errorCode');
  },
);
