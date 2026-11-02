import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { expect, it } from 'vite-plus/test';
import {
  decodeCloudflareOperationResult,
  encodeCloudflareOperation,
} from '../../src/cli/cloudflare-process.ts';

function runSecretBulk(
  input: string,
  options?: { preloadBody?: string; recordCallsPath?: string },
) {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-secret-bulk-test-'));
  try {
    const config = join(directory, 'wrangler.json');
    const capture = join(directory, 'cf-args.json');
    const bulkBody = join(directory, 'bulk-body.json');
    const callLog = join(directory, 'cf-call-log.json');
    const preload = join(directory, 'capture-cf.mjs');
    writeFileSync(config, JSON.stringify({ name: 'my-worker', account_id: 'test-account' }));
    writeFileSync(
      preload,
      options?.preloadBody ??
        `import child from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawnSync = child.spawnSync.bind(child);
child.spawnSync = (binary, args, options) => {
  const isCfCli = Array.isArray(args) && typeof args[0] === 'string' && /(?:\\/|^)cf$/.test(args[0]);
  if (!isCfCli) {
    return originalSpawnSync(binary, args, options);
  }
  writeFileSync(process.env.VOID_TEST_CF_CAPTURE, JSON.stringify(args));
  const fileIndex = args.indexOf('--file');
  if (fileIndex >= 0) {
    writeFileSync(process.env.VOID_TEST_BULK_BODY, readFileSync(args[fileIndex + 1], 'utf8'));
  }
  return { status: 0, stdout: '{}', stderr: '' };
};
syncBuiltinESMExports();
`,
    );
    const entry = join(
      import.meta.dirname,
      '..',
      '..',
      'src',
      'cli',
      'cloudflare-operation-process.ts',
    );
    const operation: CloudflareOperation = {
      type: 'secret.bulk',
      configPath: config,
      workerName: 'my-worker',
    };
    const child = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, entry, ...encodeCloudflareOperation(operation)],
      {
        env: {
          ...process.env,
          VOID_TEST_CF_CAPTURE: capture,
          VOID_TEST_BULK_BODY: bulkBody,
          VOID_TEST_CALL_LOG: callLog,
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
        },
        encoding: 'utf8',
        input,
      },
    );
    const result = decodeCloudflareOperationResult({
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
    });
    return {
      cfArgs: existsSync(capture)
        ? (JSON.parse(readFileSync(capture, 'utf8')) as Array<string>).slice(1)
        : undefined,
      bulkPayload: existsSync(bulkBody)
        ? (JSON.parse(readFileSync(bulkBody, 'utf8')) as unknown)
        : undefined,
      calls: existsSync(callLog)
        ? (JSON.parse(readFileSync(callLog, 'utf8')) as Array<string>)
        : [],
      result,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('wraps Workers secrets bulk payload in a secrets object', () => {
  const { cfArgs, bulkPayload, result } = runSecretBulk(
    JSON.stringify({ ONE: 'first', TWO: 'second' }),
  );
  expect(result.status, result.stderr).toBe(0);
  expect(cfArgs!.slice(0, -1)).toEqual([
    'workers',
    'secrets',
    'bulk',
    '--worker',
    'my-worker',
    '--file',
  ]);
  expect(cfArgs!.at(-1)).toMatch(/body\.json$/);
  expect(bulkPayload).toEqual({
    secrets: {
      ONE: { type: 'secret_text', text: 'first' },
      TWO: { type: 'secret_text', text: 'second' },
    },
  });
});

it('returns a non-zero status when secret bulk draft deploy fails after Worker 10007', () => {
  const { calls, result } = runSecretBulk(JSON.stringify({ ONE: 'first' }), {
    preloadBody: `import child from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawnSync = child.spawnSync.bind(child);
child.spawnSync = (binary, args, options) => {
  const isCfCli = Array.isArray(args) && typeof args[0] === 'string' && /(?:\\/|^)cf$/.test(args[0]);
  if (!isCfCli) {
    return originalSpawnSync(binary, args, options);
  }
  const label = args.slice(1).join(' ');
  const logPath = process.env.VOID_TEST_CALL_LOG;
  const calls = logPath && existsSync(logPath)
    ? JSON.parse(readFileSync(logPath, 'utf8'))
    : [];
  calls.push(label);
  if (logPath) {
    writeFileSync(logPath, JSON.stringify(calls));
  }
  if (label.includes('workers secrets bulk')) {
    return { status: 1, stdout: '', stderr: '[10007] Worker script not found.' };
  }
  if (label.includes('deploy') && label.includes('--prebuilt')) {
    return { status: 1, stdout: '', stderr: 'Draft deploy failed.' };
  }
  return { status: 0, stdout: '{}', stderr: '' };
};
syncBuiltinESMExports();`,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Draft deploy failed.');
  expect(calls.some((call) => call.includes('workers secrets bulk'))).toBe(true);
  expect(calls.some((call) => call.includes('void:secret-draft'))).toBe(true);
  expect(calls.filter((call) => call.includes('workers secrets bulk'))).toHaveLength(1);
});
