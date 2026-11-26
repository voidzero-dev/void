import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { runScan } from '../../src/runner/run.ts';
import type { StatusFile } from '../../src/runner/status.ts';
import { chatToolCall, chatToolCalls, startFakeModel } from '../fake-model/server.ts';
import type { FakeModel } from '../fake-model/server.ts';
import { confirmed, lead, report } from '../helpers/findings.ts';
import { buildTar } from '../helpers/tar.ts';

const MAIN = fileURLToPath(new URL('../../src/runner/main.ts', import.meta.url));

let dir: string;
let root: string;
let model: FakeModel | undefined;

const USERS_TS = [
  'export async function listUsers(req, env) {',
  '  const orderBy = new URL(req.url).searchParams.get("order");',
  '  return env.DB.prepare(`SELECT * FROM users ORDER BY ${orderBy}`).all();',
  '}',
].join('\n');

const TASK = {
  version: 1,
  scan_id: 'ss_test',
  attempt: 1,
  engine: 'void_loop',
  model: '@cf/zai-org/glm-5.3',
  tier: 'built_diff',
  changed_files: ['src/users.ts'],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanner-loop-'));
  root = join(dir, 'scan');
  await mkdir(join(root, 'input/src'), { recursive: true });
  await mkdir(join(root, 'memory'), { recursive: true });
  await writeFile(join(root, 'input/src/users.ts'), USERS_TS);
  await writeFile(join(root, 'memory/index.json'), '{"findings":[]}');
  await writeFile(join(root, 'task.json'), JSON.stringify(TASK));
  await writeFile(join(dir, 'host-secret.txt'), 'CF_API_TOKEN=leak');
});

afterEach(async () => {
  await model?.close();
  model = undefined;
  await rm(dir, { recursive: true, force: true });
});

const SQL = confirmed({
  file: 'src/users.ts',
  sink_path: 'src/users.ts',
  trace: [{ file: 'src/users.ts', line: 3, note: 'order concatenated into SQL' }],
});

const readStatus = async (scanRoot: string) =>
  JSON.parse(await readFile(join(scanRoot, 'out/status.json'), 'utf8')) as StatusFile;

describe('Engine B on the fake model', () => {
  test('a full scan writes findings.json and status.json; calls carry no key and four tools', async () => {
    model = await startFakeModel([
      chatToolCall('read_file', { path: '/scan/input/src/users.ts' }),
      chatToolCall('submit_findings', report([SQL, lead({ file: 'src/users.ts' })])),
      chatToolCall('submit_findings', report([SQL])),
      chatToolCall('read_file', { path: '/scan/input/src/users.ts' }),
      chatToolCall('submit_findings', report([])),
    ]);
    const status = await runScan({ root, baseUrl: model.url, retryDelayMs: 0 });
    expect(status).toMatchObject({
      status: 'succeeded',
      model_calls: 5,
      findings: { confirmed: 1, needs_validation: 0, rejected: 1 },
    });
    expect(await readStatus(root)).toEqual(status);
    for (const request of model.requests) {
      expect(request.path).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBeUndefined();
      const body = request.body as { tools: Array<{ function: { name: string } }> };
      expect(body.tools.map((t) => t.function.name)).toEqual([
        'read_file',
        'list_files',
        'grep',
        'submit_findings',
      ]);
    }
  });

  test('path tricks, unknown tools and reads of memory, lists or searches read nothing', async () => {
    let sent = '';
    for (const calls of [
      [
        { name: 'read_file', arguments: { path: '../../host-secret.txt' } },
        { name: 'read_file', arguments: { path: '/proc/self/environ' } },
        { name: 'shell', arguments: { command: 'cat /etc/passwd' } },
      ],
      [
        { name: 'read_file', arguments: { path: '/scan/memory/index.json' } },
        { name: 'list_files', arguments: { path: '/scan/input' } },
        { name: 'grep', arguments: { pattern: 'no-such-text' } },
      ],
    ]) {
      await model?.close();
      model = await startFakeModel([
        chatToolCalls(calls),
        chatToolCall('submit_findings', report([])),
      ]);
      // A decline with no code read cannot clear the scan (spike S9 B5).
      expect(await runScan({ root, baseUrl: model.url, retryDelayMs: 0 })).toMatchObject({
        status: 'failed',
        reason: 'bad_output',
        error_class: 'nothing_read',
      });
      sent += JSON.stringify(model.requests);
    }
    // Tool errors went back to the model; the host file never did.
    expect(sent).toContain('unknown tool');
    expect(sent).not.toContain('CF_API_TOKEN=leak');
  });
});

describe('runner CLI', () => {
  function runCli(scanRoot: string, url: string, stdin: Uint8Array) {
    return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const args = [MAIN, '--root', scanRoot, '--stdin-tar', '--model-base-url', url];
      const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(stdin);
    });
  }

  test('runs a scan from the stdin tar; a bad tar fails input_invalid before any call', async () => {
    model = await startFakeModel([
      chatToolCall('read_file', { path: 'src/users.ts' }),
      chatToolCall('submit_findings', report([SQL])),
      chatToolCall('submit_findings', report([SQL])),
    ]);
    const task = { name: 'task.json', data: JSON.stringify(TASK) };
    const good = join(dir, 'fresh');
    const ok = await runCli(
      good,
      model.url,
      buildTar([task, { name: 'input/src/users.ts', data: USERS_TS }]),
    );
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ status: 'succeeded', reason: null });
    expect((await readStatus(good)).findings.confirmed).toBe(1);

    const calls = model.requests.length;
    const evil = join(dir, 'evil');
    const tar = buildTar([task, { name: 'input/link', type: '2', linkname: '/etc/passwd' }]);
    expect((await runCli(evil, model.url, tar)).code).toBe(0);
    expect(await readStatus(evil)).toMatchObject({
      status: 'failed',
      reason: 'infrastructure',
      error_class: 'input_invalid',
    });
    expect(model.requests).toHaveLength(calls);
  });
});
