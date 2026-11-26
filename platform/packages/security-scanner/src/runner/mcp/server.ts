// `void-scan`: the only tools Engine C (Codex) gets, as a small stdio MCP server (spec
// §15.4). Newline-delimited JSON-RPC 2.0, no dependencies. The three read tools are the
// same code Engine B calls (`tools/fs.ts`), so the same path rules apply; `submit_findings`
// checks the report and writes it to the file the runner named. The first refused report
// gets its error back so the model can fix it; the runner reads what was accepted.

import { validateFindingsLenient } from '../coerce.ts';
import { scanToolDefinitions } from '../tools/definitions.ts';
import { readToolsByName } from '../tools/fs.ts';
import type { FsTools, ToolResult } from '../tools/fs.ts';
import { writeWhole } from '../util.ts';
import { describeValidationError } from '../validate-findings.ts';

export type McpServerOptions = {
  tools: FsTools;
  /**
   * Where an accepted report goes. A refused one is noted in `<outPath>.rejected`, and the
   * number of read_file calls that returned code in `<outPath>.reads` (`stats.reads`).
   */
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

export function createMcpServer(options: McpServerOptions): McpServer {
  const definitions = scanToolDefinitions();
  const readTools = readToolsByName(options.tools);
  let submitted = false;
  let rejections = 0;
  let codeReads = 0;

  async function reject(kind: string, message: string): Promise<ToolResult> {
    rejections++;
    await writeWhole(
      `${options.outPath}.rejected`,
      JSON.stringify({ count: rejections, kind, message }),
    );
    return {
      ok: false,
      text:
        rejections === 1
          ? `error: your last output was invalid: ${message}. Fix it and call submit_findings again. This is your only retry.`
          : 'error: the report was not accepted again. Stop and answer with the status only.',
    };
  }

  async function submit(args: Json): Promise<ToolResult> {
    if (submitted) {
      return { ok: false, text: 'error: the report was already accepted. The session is over.' };
    }
    const checked = validateFindingsLenient(args);
    if (!checked.ok) {
      return reject(checked.kind, describeValidationError(checked));
    }
    if (options.maxRecords !== undefined && checked.report.findings.length > options.maxRecords) {
      return reject(
        'shape',
        'a verify session submits exactly one record, for the candidate it was given',
      );
    }
    await writeWhole(options.outPath, JSON.stringify(checked.report));
    submitted = true;
    return { ok: true, text: `accepted ${checked.report.findings.length} records` };
  }

  async function call(name: unknown, args: Json): Promise<ToolResult> {
    if (name === 'submit_findings') {
      return submit(args);
    }
    const tool = typeof name === 'string' ? readTools.get(name) : undefined;
    if (!tool) {
      return { ok: false, text: 'error: unknown tool' };
    }
    const result = await tool(args);
    if (name === 'read_file' && result.code === true) {
      codeReads++;
      await writeWhole(`${options.outPath}.reads`, JSON.stringify({ count: codeReads }));
    }
    return result;
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
      const input = (params ?? {}) as Json;
      switch (method) {
        case 'initialize':
          return ok({
            protocolVersion:
              typeof input.protocolVersion === 'string' ? input.protocolVersion : '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'void-scan', version: '1' },
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
                readOnlyHint: tool.name !== 'submit_findings',
                destructiveHint: false,
                openWorldHint: false,
              },
            })),
          });
        case 'tools/call': {
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
          return { jsonrpc: '2.0', id, error: { code: -32_601, message: 'method not found' } };
      }
    },
  };
}
