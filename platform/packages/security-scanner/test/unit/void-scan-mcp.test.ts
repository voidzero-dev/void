import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { createMcpServer, type McpServer } from '../../src/runner/mcp/server.ts';
import { createFsTools } from '../../src/runner/tools/fs.ts';
import { confirmed, report } from '../helpers/findings.ts';

type Reply = {
  result: {
    isError: boolean;
    content: Array<{ text: string }>;
    tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
  };
  error?: { code: number };
};

let dir: string;
let out: string;
let server: McpServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanner-mcp-'));
  await mkdir(join(dir, 'scan/input'), { recursive: true });
  await writeFile(join(dir, 'scan/input/a.ts'), 'line one\nline two\n');
  await writeFile(join(dir, 'secret.txt'), 'token');
  out = join(dir, 'report.json');
  server = createMcpServer({ tools: createFsTools({ root: join(dir, 'scan') }), outPath: out });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

let nextId = 0;
async function rpc(method: string, params?: unknown, instance: McpServer = server) {
  const reply = await instance.handle({ jsonrpc: '2.0', id: ++nextId, method, params });
  return reply as unknown as Reply;
}
const call = (name: string, args: unknown, instance?: McpServer) =>
  rpc('tools/call', { name, arguments: args }, instance);

describe('void-scan MCP server', () => {
  test('answers initialize, ping and lists exactly the four tools as read-only or not', async () => {
    expect((await rpc('initialize', { protocolVersion: '2025-03-26' })).result).toMatchObject({
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'void-scan' },
    });
    expect((await rpc('ping')).result).toEqual({});
    const tools = (await rpc('tools/list')).result.tools;
    expect(tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([
      ['read_file', true],
      ['list_files', true],
      ['grep', true],
      ['submit_findings', false],
    ]);
    expect((await rpc('nope')).error?.code).toBe(-32601);
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await server.handle('junk')).toBeNull();
  });

  test('read tools use the same path rules as Engine B', async () => {
    const ok = await call('read_file', { path: 'a.ts' });
    expect(ok.result.isError).toBe(false);
    expect(ok.result.content[0].text).toContain('line two');
    const outside = await call('read_file', { path: '../../secret.txt' });
    expect(outside.result.isError).toBe(true);
    expect(outside.result.content[0].text).not.toContain('token');
    expect((await call('grep', { pattern: 'one' })).result.content[0].text).toContain('a.ts');
    expect((await call('shell', { cmd: 'id' })).result.isError).toBe(true);
  });

  test('submit_findings writes an accepted report whole and refuses a second one', async () => {
    const accepted = await call('submit_findings', report([confirmed()]));
    expect(accepted.result.isError).toBe(false);
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({ run_status: 'complete' });
    const again = await call('submit_findings', report([]));
    expect(again.result.isError).toBe(true);
    expect(JSON.parse(await readFile(out, 'utf8')).findings).toHaveLength(1);
  });

  test('repairs a harmless slip before it checks', async () => {
    const slip = { ...confirmed(), severity: 'High', extra: true };
    expect((await call('submit_findings', report([slip]))).result.isError).toBe(false);
  });

  test('the first refused report gets its error and one retry; the second is final', async () => {
    const bad = report([confirmed({ fix: '' })]);
    const first = await call('submit_findings', bad);
    expect(first.result.isError).toBe(true);
    expect(first.result.content[0].text).toContain('your last output was invalid');
    expect(first.result.content[0].text).toContain('only retry');
    expect(existsSync(out)).toBe(false);
    const second = await call('submit_findings', bad);
    expect(second.result.content[0].text).toContain('not accepted again');
    expect(JSON.parse(await readFile(`${out}.rejected`, 'utf8'))).toMatchObject({
      count: 2,
      kind: 'shape',
    });
    // A good report after that is still taken: the runner decides what the session was.
    expect((await call('submit_findings', report([confirmed()]))).result.isError).toBe(false);
  });

  test('a verify session may submit one record', async () => {
    const verify = createMcpServer({
      tools: createFsTools({ root: join(dir, 'scan') }),
      outPath: join(dir, 'verify.json'),
      maxRecords: 1,
    });
    const two = report([confirmed(), confirmed({ fingerprint: 'b' })]);
    const refused = await call('submit_findings', two, verify);
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain('exactly one record');
    expect((await call('submit_findings', report([confirmed()]), verify)).result.isError).toBe(
      false,
    );
  });
});
