// Entry of `dist/void-scan-mcp.mjs`, started by Codex as an MCP server:
//   node void-scan-mcp.mjs --root /scan --out <report.json> [--max-records 1]

import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createFsTools } from '../tools/fs.ts';
import { createMcpServer } from './server.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string', default: '/scan' },
    out: { type: 'string' },
    'max-records': { type: 'string' },
  },
  strict: true,
});
if (values.out === undefined) {
  process.stderr.write('void-scan: --out is required\n');
  process.exit(2);
}
const maxRecords = values['max-records'] === undefined ? undefined : Number(values['max-records']);
const server = createMcpServer({
  tools: createFsTools({ root: values.root }),
  outPath: values.out,
  maxRecords: maxRecords !== undefined && Number.isInteger(maxRecords) ? maxRecords : undefined,
});

// One request at a time, in order: the model's calls are sequential anyway.
let queue: Promise<void> = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (line.trim() === '') {
    return;
  }
  queue = queue.then(async () => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const reply = await server.handle(message);
    if (reply !== null) {
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
});
