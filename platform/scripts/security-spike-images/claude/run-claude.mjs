// Engine A runner for spike S2: the Claude Agent SDK, locked down per spec §15.3.
// Started by the controller as the non-root `scanner` user with a task JSON on stdin:
//   { "model": "...", "baseUrl": "http://model.scan.internal", "prompt": "...", "maxTurns": 40 }
// Prints one JSON line `{ "engineResult": ... }` with the init message (tools, MCP
// servers, skills, plugins), every tool call and its result, hook denials, the SDK result
// and whether the structured output passes the report schema.
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { validateReport } from './validate.mjs';

const ROOT = '/scan/input';
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const task = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const schema = JSON.parse(readFileSync('/opt/scanner/report-schema.json', 'utf8'));
// Per-run config dir; HOME points at it too, so no user-level settings can load.
const configDir = mkdtempSync('/home/scanner/claude-run-');

function underRoot(candidate) {
  if (typeof candidate !== 'string' || candidate === '') {
    return true;
  }
  const absolute = resolve(ROOT, candidate);
  let real = absolute;
  try {
    real = realpathSync(absolute);
  } catch {
    // Missing file: judge the lexical path.
  }
  return real === ROOT || real.startsWith(`${ROOT}/`);
}

const hookLog = [];
async function preToolUse(input) {
  const toolInput = input.tool_input ?? {};
  const paths = [toolInput.file_path, toolInput.path, toolInput.notebook_path];
  if (typeof toolInput.pattern === 'string' && toolInput.pattern.startsWith('/')) {
    paths.push(toolInput.pattern);
  }
  const outside = paths.filter((p) => p !== undefined && !underRoot(p));
  if (outside.length > 0) {
    hookLog.push({ tool: input.tool_name, decision: 'deny', paths: outside });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Only files under ${ROOT} can be read.`,
      },
    };
  }
  hookLog.push({ tool: input.tool_name, decision: 'allow' });
  return {};
}

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Skill'];
const started = Date.now();
// Optional wall-clock limit (task.timeoutMs): the SDK stops the CLI when it fires.
const abortController = new AbortController();
const timer = task.timeoutMs ? setTimeout(() => abortController.abort(), task.timeoutMs) : null;
const out = { init: null, toolCalls: [], toolResults: [], result: null, stderrTail: '' };
const stderr = [];
try {
  for await (const message of query({
    prompt: task.prompt,
    options: {
      cwd: ROOT,
      model: task.model,
      tools: READ_TOOLS,
      allowedTools: READ_TOOLS,
      disallowedTools: [
        'Bash',
        'Write',
        'Edit',
        'NotebookEdit',
        'WebFetch',
        'WebSearch',
        'Agent',
        'Task',
        'mcp__*',
      ],
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      plugins: [{ type: 'local', path: '/opt/scanner/plugin' }],
      // Only our skill is listed and callable; bundled skills are removed (env below).
      skills: ['void-security:void-security-review'],
      outputFormat: { type: 'json_schema', schema },
      // Built-in plugins off (task.managedSettings), so only our plugin adds skills or hooks.
      ...(task.managedSettings ? { managedSettings: task.managedSettings } : {}),
      maxTurns: task.maxTurns ?? 40,
      abortController,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      stderr: (data) => stderr.push(data),
      // Replaces the environment: no token of any kind, only the proxy route.
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: configDir,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: task.baseUrl,
        ANTHROPIC_API_KEY: 'placeholder-not-a-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        // Optional retry cap for the CLI's model calls (S2 --local-gateway 402 run).
        ...(task.maxRetries !== undefined
          ? { CLAUDE_CODE_MAX_RETRIES: String(task.maxRetries) }
          : {}),
        // Lets HTTPS to any other host finish TLS against the controller's intercept, so
        // its deny handler records the attempt (it is denied either way).
        NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
      },
    },
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      out.init = {
        tools: message.tools,
        mcpServers: message.mcp_servers,
        slashCommands: message.slash_commands,
        skills: message.skills,
        plugins: message.plugins,
        agents: message.agents,
        permissionMode: message.permissionMode,
        model: message.model,
        cwd: message.cwd,
        claudeCodeVersion: message.claude_code_version,
      };
    } else if (message.type === 'assistant') {
      for (const block of message.message.content ?? []) {
        if (block.type === 'tool_use') {
          out.toolCalls.push({ id: block.id, name: block.name, input: block.input });
        }
      }
    } else if (message.type === 'user') {
      const content = message.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'tool_result') {
          const text = Array.isArray(block.content)
            ? block.content.map((part) => part.text ?? '').join('\n')
            : String(block.content ?? '');
          out.toolResults.push({
            id: block.tool_use_id,
            isError: block.is_error === true,
            text: text.slice(0, 300),
          });
        }
      }
    } else if (message.type === 'result') {
      out.result = {
        subtype: message.subtype,
        isError: message.is_error,
        numTurns: message.num_turns,
        durationMs: message.duration_ms,
        usage: message.usage,
        permissionDenials: message.permission_denials,
        structuredOutput: message.structured_output,
        errors: message.errors,
        stopReason: message.stop_reason,
      };
    }
  }
} catch (error) {
  out.error = String(error?.stack ?? error).slice(0, 2000);
}
if (timer) {
  clearTimeout(timer);
}
out.aborted = abortController.signal.aborted;
out.hookLog = hookLog;
out.wallMs = Date.now() - started;
out.schemaProblems = out.result?.structuredOutput
  ? validateReport(out.result.structuredOutput)
  : ['no structured output'];
out.stderrTail = stderr.join('').slice(-1500);
console.log(JSON.stringify({ engineResult: out }));
