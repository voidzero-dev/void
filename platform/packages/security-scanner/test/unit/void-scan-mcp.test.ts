import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { createMcpServer } from '../../src/runner/mcp/server.ts';
import type { McpServer } from '../../src/runner/mcp/server.ts';
import { createFsTools } from '../../src/runner/tools/fs.ts';
import { confirmed, report } from '../helpers/findings.ts';

type Reply = {
  result: { isError: boolean; content: Array<{ text: string }>; tools: Array<{ name: string }> };
};

let dir: string;
let out: string;
let server: McpServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scanner-mcp-'));
  await mkdir(join(dir, 'scan/input'), { recursive: true });
  await writeFile(join(dir, 'scan/input/a.ts'), 'line one\nline two\n');
  await writeFile(join(dir, 'scan/input/blank.ts'), '\n');
  await writeFile(join(dir, 'secret.txt'), 'token');
  out = join(dir, 'report.json');
  server = createMcpServer({ tools: createFsTools({ root: join(dir, 'scan') }), outPath: out });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

let nextId = 0;
async function rpc(method: string, params?: unknown) {
  return (await server.handle({ jsonrpc: '2.0', id: ++nextId, method, params })) as Reply;
}
const call = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args });

describe('void-scan MCP server', () => {
  test('offers only the four scan tools and the Engine B path rules; counts code reads', async () => {
    const tools = (await rpc('tools/list')).result.tools;
    expect(tools.map((t) => t.name)).toEqual([
      'read_file',
      'list_files',
      'grep',
      'submit_findings',
    ]);
    expect((await call('shell', { cmd: 'id' })).result.isError).toBe(true);
    for (const path of ['../../secret.txt', '/proc/self/environ', 'blank.ts', 'missing.ts']) {
      const result = await call('read_file', { path });
      expect(result.result.content[0].text).not.toContain('token');
    }
    expect(existsSync(`${out}.reads`)).toBe(false);
    expect((await call('read_file', { path: 'a.ts' })).result.content[0].text).toContain('two');
    expect(JSON.parse(await readFile(`${out}.reads`, 'utf8'))).toEqual({ count: 1 });
  });

  test('a refused report gets one retry; an accepted one is final', async () => {
    const bad = report([confirmed({ fix: '' })]);
    expect((await call('submit_findings', bad)).result.content[0].text).toContain('only retry');
    expect((await call('submit_findings', bad)).result.content[0].text).toContain(
      'not accepted again',
    );
    expect(JSON.parse(await readFile(`${out}.rejected`, 'utf8'))).toMatchObject({ count: 2 });
    expect((await call('submit_findings', report([confirmed()]))).result.isError).toBe(false);
    expect((await call('submit_findings', report([]))).result.isError).toBe(true);
    expect(JSON.parse(await readFile(out, 'utf8')).findings).toHaveLength(1);
  });
});
