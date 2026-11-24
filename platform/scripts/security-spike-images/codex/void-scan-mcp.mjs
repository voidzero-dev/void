// void-scan: the only tools Engine C (Codex) gets, as a small stdio MCP server.
// Newline-delimited JSON-RPC 2.0 (MCP stdio transport), no dependencies.
//   read_file(path, offset?, limit?)  list_files(path?)  grep(pattern, path?)  submit_findings(report)
// Every path must resolve (realpath) under /scan/input. Read tools are marked
// readOnlyHint. submit_findings checks the report schema and writes it to the file named
// by argv[2]; a bad report gets the validator error back once so the model can fix it.
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { validateReport } from './validate.mjs';

const ROOT = '/scan/input';
const OUT = process.argv[2];
const MAX_BYTES = 256 * 1024;
const LOG = [];

function inside(candidate) {
  const absolute = resolve(ROOT, candidate ?? '.');
  let real;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new Error(`not found: ${candidate}`);
  }
  if (real !== ROOT && !real.startsWith(`${ROOT}/`)) {
    throw new Error(`Only files under ${ROOT} can be read.`);
  }
  return real;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, out);
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

const tools = {
  read_file: {
    description: 'Read a text file under /scan/input. Returns numbered lines.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run({ path, offset = 1, limit = 400 }) {
      const real = inside(path);
      if (!statSync(real).isFile()) {
        throw new Error('not a regular file');
      }
      const lines = readFileSync(real, 'utf8').slice(0, MAX_BYTES).split('\n');
      return lines
        .slice(Math.max(0, offset - 1), Math.max(0, offset - 1) + limit)
        .map((line, index) => `${offset + index}: ${line}`)
        .join('\n');
    },
  },
  list_files: {
    description: 'List regular files under a folder in /scan/input.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    },
    run({ path }) {
      return walk(inside(path), [])
        .map((p) => relative(ROOT, p))
        .sort()
        .join('\n');
    },
  },
  grep: {
    description: 'Find lines that contain a literal string, in files under /scan/input.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
      additionalProperties: false,
    },
    run({ pattern, path }) {
      const hits = [];
      const base = inside(path);
      const files = statSync(base).isFile() ? [base] : walk(base, []);
      for (const file of files) {
        readFileSync(file, 'utf8')
          .slice(0, MAX_BYTES)
          .split('\n')
          .forEach((line, index) => {
            if (line.includes(pattern) && hits.length < 200) {
              hits.push(`${relative(ROOT, file)}:${index + 1}: ${line}`);
            }
          });
      }
      return hits.join('\n') || 'no matches';
    },
  },
  submit_findings: {
    description: 'Submit the final security report. Call exactly once.',
    readOnly: false,
    inputSchema: JSON.parse(readFileSync('/opt/scanner/report-schema.json', 'utf8')),
    run(report) {
      const problems = validateReport(report);
      if (problems.length > 0) {
        throw new Error(`report rejected: ${problems.join('; ')}`);
      }
      writeFileSync(OUT, JSON.stringify(report));
      return `accepted ${report.findings.length} findings`;
    },
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) {
    return; // notification
  }
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'void-scan', version: '0.0.0-spike' },
      },
    });
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: Object.entries(tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            readOnlyHint: tool.readOnly,
            destructiveHint: false,
            openWorldHint: false,
          },
        })),
      },
    });
  } else if (method === 'tools/call') {
    const tool = tools[params?.name];
    let result;
    try {
      if (!tool) {
        throw new Error(`unknown tool ${params?.name}`);
      }
      result = { content: [{ type: 'text', text: tool.run(params.arguments ?? {}) }] };
      LOG.push({ tool: params.name, ok: true });
    } catch (error) {
      result = { content: [{ type: 'text', text: String(error.message ?? error) }], isError: true };
      LOG.push({ tool: params?.name, ok: false, error: String(error.message ?? error) });
    }
    if (OUT) {
      writeFileSync(`${OUT}.calls.json`, JSON.stringify(LOG));
    }
    send({ jsonrpc: '2.0', id, result });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32_601, message: `method not found: ${method}` } });
  }
});
