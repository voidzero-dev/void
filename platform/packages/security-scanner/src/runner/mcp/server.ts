// `void-scan`: the only tools Engine C (Codex) gets, as a small stdio MCP server (spec
// §15.4). Newline-delimited JSON-RPC 2.0, no dependencies. The three read tools are the
// same code Engine B calls (`tools/fs.ts`), so the same path rules apply; `submit_findings`
// checks the report and writes it to the file the runner named. The first refused report
// gets its error back so the model can fix it; the runner reads what was accepted.

import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { validateFindingsLenient } from '../coerce.ts';
import { scanToolDefinitions } from '../tools/definitions.ts';
import type { FsTools, ToolResult } from '../tools/fs.ts';
import { describeValidationError } from '../validate-findings.ts';

export const MCP_SERVER_NAME = 'void-scan';
export const MCP_SERVER_VERSION = '1';

export type McpServerOptions = {
  tools: FsTools;
  /** Where an accepted report goes. A refused one is noted in `<outPath>.rejected`. */
  outPath: string;
  /** A verify session submits one record at most. */
  maxRecords?: number;
};

type Json = Record<string, unknown>;
type Reply = {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export type McpServer = { handle(message: unknown): Promise<Reply | null> };

async function writeWhole(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp`;
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const definitions = scanToolDefinitions();
  let submitted = false;
  let rejections = 0;

  async function submit(args: Json): Promise<ToolResult> {
    if (submitted) {
      return { ok: false, text: 'error: the report was already accepted. The session is over.' };
    }
    const checked = validateFindingsLenient(args);
    let problem: { kind: string; message: string } | null = null;
    if (!checked.ok) {
      problem = { kind: checked.kind, message: describeValidationError(checked) };
    } else if (
      options.maxRecords !== undefined &&
      checked.report.findings.length > options.maxRecords
    ) {
      problem = {
        kind: 'shape',
        message: `a verify session submits exactly one record, for the candidate it was given`,
      };
    }
    if (problem !== null || !checked.ok) {
      rejections++;
      const note = problem ?? { kind: 'shape', message: 'report refused' };
      await writeWhole(
        `${options.outPath}.rejected`,
        JSON.stringify({ count: rejections, ...note }),
      );
      return {
        ok: false,
        text:
          rejections === 1
            ? `error: your last output was invalid: ${note.message}. Fix it and call submit_findings again. This is your only retry.`
            : 'error: the report was not accepted again. Stop and answer with the status only.',
      };
    }
    await writeWhole(options.outPath, JSON.stringify(checked.report));
    submitted = true;
    return { ok: true, text: `accepted ${checked.report.findings.length} records` };
  }

  async function call(name: unknown, args: Json): Promise<ToolResult> {
    switch (name) {
      case 'read_file':
        return options.tools.readFile(args);
      case 'list_files':
        return options.tools.listFiles(args);
      case 'grep':
        return options.tools.grep(args);
      case 'submit_findings':
        return submit(args);
      default:
        return { ok: false, text: 'error: unknown tool' };
    }
  }

  return {
    async handle(message: unknown): Promise<Reply | null> {
      if (typeof message !== 'object' || message === null) {
        return null;
      }
      const { id, method, params } = message as Json;
      if (id === undefined) {
        return null; // a notification
      }
      const ok = (result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
      switch (method) {
        case 'initialize':
          return ok({
            protocolVersion:
              typeof (params as Json | undefined)?.protocolVersion === 'string'
                ? (params as Json).protocolVersion
                : '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          });
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({
            tools: definitions.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters,
              annotations: {
                readOnlyHint: tool.readOnly,
                destructiveHint: false,
                openWorldHint: false,
              },
            })),
          });
        case 'tools/call': {
          const input = (params ?? {}) as Json;
          const args =
            typeof input.arguments === 'object' && input.arguments !== null
              ? (input.arguments as Json)
              : {};
          let result: ToolResult;
          try {
            result = await call(input.name, args);
          } catch {
            result = { ok: false, text: 'error: the tool failed' };
          }
          return ok({ content: [{ type: 'text', text: result.text }], isError: !result.ok });
        }
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: 'method not found' },
          };
      }
    },
  };
}
