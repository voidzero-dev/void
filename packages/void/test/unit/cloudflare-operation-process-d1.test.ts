import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { expect, it } from 'vite-plus/test';
import {
  decodeCloudflareOperationResult,
  encodeCloudflareOperation,
} from '../../src/cli/cloudflare-process.ts';

it('passes the validated custom D1 migration pattern to cf', () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-d1-pattern-test-'));
  try {
    const config = join(directory, 'wrangler.json');
    const capture = join(directory, 'cf-args.json');
    const preload = join(directory, 'capture-cf.mjs');
    writeFileSync(
      config,
      JSON.stringify({
        d1_databases: [
          {
            binding: 'DB',
            database_id: 'database-id',
            migrations_dir: 'db/migrations',
            migrations_pattern: 'db/migrations/*/migration.sql',
          },
        ],
      }),
    );
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
child.spawnSync = (_binary, args) => {
  writeFileSync(process.env.VOID_TEST_CF_CAPTURE, JSON.stringify(args));
  return { status: 0, stdout: '[]', stderr: '' };
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
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        entry,
        ...encodeCloudflareOperation({
          type: 'd1.migrations.list',
          database: 'DB',
          configPath: config,
        }),
      ],
      {
        env: { ...process.env, VOID_TEST_CF_CAPTURE: capture },
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect((JSON.parse(readFileSync(capture, 'utf8')) as Array<string>).slice(1)).toEqual([
      'd1',
      'migrations',
      'list',
      'database-id',
      '--dir',
      'db/migrations',
      '--pattern',
      'db/migrations/*/migration.sql',
      '--table',
      'd1_migrations',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Runs the operation process with cf replaced, and returns cf's argv and the decoded result.
function runWithCf(operation: CloudflareOperation, cfStdout: string, cfStatus = 0, cfStderr = '') {
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-d1-time-travel-test-'));
  try {
    const config = join(directory, 'wrangler.json');
    const capture = join(directory, 'cf-args.json');
    const preload = join(directory, 'capture-cf.mjs');
    writeFileSync(
      config,
      JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: 'database-id' }] }),
    );
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
child.spawnSync = (_binary, args) => {
  writeFileSync(process.env.VOID_TEST_CF_CAPTURE, JSON.stringify(args));
  return {
    status: Number(process.env.VOID_TEST_CF_STATUS),
    stdout: process.env.VOID_TEST_CF_STDOUT,
    stderr: process.env.VOID_TEST_CF_STDERR,
  };
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
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        entry,
        ...encodeCloudflareOperation({ ...operation, configPath: config }),
      ],
      {
        env: {
          ...process.env,
          VOID_TEST_CF_CAPTURE: capture,
          VOID_TEST_CF_STDOUT: cfStdout,
          VOID_TEST_CF_STATUS: String(cfStatus),
          VOID_TEST_CF_STDERR: cfStderr,
        },
        encoding: 'utf8',
      },
    );
    return {
      cfArgs: (JSON.parse(readFileSync(capture, 'utf8')) as Array<string>).slice(1),
      result: decodeCloudflareOperationResult({
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
      }),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const bookmark = '00000085-0000024c-00004ef2-0a83ea2fceebc654de0640c422be4653';

it('takes the D1 Time Travel bookmark through cf by database id', () => {
  const { cfArgs, result } = runWithCf(
    { type: 'd1.time-travel.bookmark', database: 'DB', configPath: '' },
    JSON.stringify({ bookmark }),
  );
  expect(result.status, result.stderr).toBe(0);
  expect(cfArgs).toEqual(['d1', 'time-travel', 'get-bookmark', 'database-id']);
  expect(result.data).toEqual({ bookmark });
});

it.each(['""', '"00000085-0000024c; rm -rf ~"'])('rejects the malformed bookmark %s', (value) => {
  const { result } = runWithCf(
    { type: 'd1.time-travel.bookmark', database: 'DB', configPath: '' },
    `{"bookmark":${value}}`,
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('D1 Time Travel bookmark was malformed.');
  expect(result.data).toBeUndefined();
});

it('restores through cf without its prompt and returns the bookmark that undoes it', () => {
  const previous = '00000085-0000024c-00004ef1-1b94fb3fdffcd765ef1751d533cf5764';
  const restored = '00000085-0000024c-00004ef3-2ca50c40e00de876f02862e644d08875';
  const { cfArgs, result } = runWithCf(
    {
      type: 'd1.time-travel.restore',
      database: 'DB',
      target: { bookmark },
      configPath: '',
    },
    JSON.stringify({ bookmark: restored, message: 'Restored', previous_bookmark: previous }),
  );
  expect(result.status, result.stderr).toBe(0);
  expect(cfArgs).toEqual([
    'd1',
    'time-travel',
    'restore',
    'database-id',
    `--bookmark=${bookmark}`,
    '--force',
  ]);
  expect(result.data).toEqual({ previousBookmark: previous });
});

it("reports a failed restore with cf's reason and no data", () => {
  const { result } = runWithCf(
    { type: 'd1.time-travel.restore', database: 'DB', target: { bookmark }, configPath: '' },
    '',
    1,
    'The bookmark is outside the Time Travel window.',
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('outside the Time Travel window');
  expect(result.data).toBeUndefined();
});

it.each(['Restored.', JSON.stringify({ previous_bookmark: 'a b;rm' })])(
  'reports a restore by timestamp as done when cf returns no valid previous bookmark (%s)',
  (stdout) => {
    const { cfArgs, result } = runWithCf(
      {
        type: 'd1.time-travel.restore',
        database: 'DB',
        target: { timestamp: '2026-10-16T09:30:00.000Z' },
        configPath: '',
      },
      stdout,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(cfArgs).toEqual([
      'd1',
      'time-travel',
      'restore',
      'database-id',
      '--timestamp=2026-10-16T09:30:00.000Z',
      '--force',
    ]);
    expect(result.data).toEqual({});
  },
);
