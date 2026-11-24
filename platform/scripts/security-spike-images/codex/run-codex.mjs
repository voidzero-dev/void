import { randomUUID } from 'node:crypto';
// Engine C runner for spike S3: the Codex SDK, locked down per spec §15.4.
// Started by the controller as the non-root `scanner` user with a task JSON on stdin:
//   { "model": "gpt-6.1-terra", "baseUrl": "http://model.scan.internal/v1", "prompt": "...",
//     "timeoutMs": 600000, "extraConfig": { ... } }
// cwd is an empty /work (never /scan); a fresh CODEX_HOME per run; the wrapper adds
// --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check,
// so every setting below arrives as a --config flag. Prints `{ "engineResult": ... }`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Codex } from '@openai/codex-sdk';
import { validateReport } from './validate.mjs';

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const task = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const runId = randomUUID();
// Not under /tmp: Codex refuses to create its helper links under a temp dir.
const codexHome = `/home/scanner/codex-${runId}`;
mkdirSync(`${codexHome}/log`, { recursive: true });
mkdirSync(`${codexHome}/sqlite`, { recursive: true });
const outPath = `${codexHome}/findings.json`;
const reportSchema = JSON.parse(readFileSync('/opt/scanner/report-schema.json', 'utf8'));
// Final message schema (--output-schema, strict): a short status; the report itself goes
// through submit_findings.
const finalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['run_status', 'finding_count'],
  properties: {
    run_status: { type: 'string', enum: ['complete', 'incomplete'] },
    finding_count: { type: 'integer' },
  },
};

const OFF = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'sleep_tool',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'tool_suggest',
  'memories',
  'image_generation',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'hooks',
  'api_key_model_discovery',
  'api_key_cyber_access_programs',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'skill_search',
  'skill_mcp_dependency_install',
  'goals',
  'daemon_auto_start',
  'in_app_updates',
  'enable_request_compression',
  'view_image',
];

const config = {
  model_provider: 'void-proxy',
  model_providers: {
    'void-proxy': {
      name: 'void-proxy',
      base_url: task.baseUrl,
      wire_api: 'responses',
      requires_openai_auth: false,
      supports_websockets: false,
      // Optional retry caps (S3 --local-gateway: Codex retries a 402 by default).
      ...(task.providerRetries ?? {}),
    },
  },
  model_catalog_json: '/opt/scanner/codex-models.json',
  model_instructions_file: '/opt/scanner/skill.md',
  approval_policy: 'never',
  sandbox_mode: 'read-only',
  web_search: 'disabled',
  project_doc_max_bytes: 0,
  project_root_markers: [],
  check_for_update_on_startup: false,
  tool_output_token_limit: 8000,
  sqlite_home: `${codexHome}/sqlite`,
  log_dir: `${codexHome}/log`,
  analytics: { enabled: false },
  feedback: { enabled: false },
  history: { persistence: 'none' },
  features: Object.fromEntries(OFF.map((name) => [name, false])),
  mcp_servers: {
    'void-scan': {
      command: '/usr/local/bin/node',
      args: ['/opt/scanner/void-scan-mcp.mjs', outPath],
      required: true,
      enabled_tools: ['read_file', 'list_files', 'grep', 'submit_findings'],
      default_tools_approval_mode: 'approve',
    },
  },
  projects: { '/scan': { trust_level: 'untrusted' }, '/work': { trust_level: 'untrusted' } },
  skills: { include_instructions: false, bundled: { enabled: false } },
  ...(task.extraConfig ?? {}),
};

const codex = new Codex({
  codexPathOverride: '/opt/scanner/codex-wrapper.sh',
  // Explicit env: no process.env, no CODEX_API_KEY (unless the task asks for a placeholder).
  env: {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: codexHome,
    CODEX_HOME: codexHome,
    SSL_CERT_FILE: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
    ...(task.placeholderApiKey ? { CODEX_API_KEY: 'placeholder-not-a-key' } : {}),
  },
  config,
});

const started = Date.now();
const out = {
  codexHome,
  events: [],
  items: [],
  finalResponse: null,
  usage: null,
  turnFailed: null,
  errors: [],
};
const abort = AbortSignal.timeout(task.timeoutMs ?? 600_000);
try {
  const thread = codex.startThread({
    model: task.model,
    workingDirectory: '/work',
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    webSearchMode: 'disabled',
  });
  const { events } = await thread.runStreamed(task.prompt, {
    outputSchema: finalSchema,
    signal: abort,
  });
  for await (const event of events) {
    out.events.push(event.type);
    if (event.type === 'item.completed') {
      const item = event.item;
      out.items.push({
        type: item.type,
        server: item.server,
        tool: item.tool,
        command: item.command,
        status: item.status,
        error: item.error?.message,
        text: (item.text ?? item.result?.content?.map((c) => c.text ?? '').join('\n') ?? '').slice(
          0,
          200,
        ),
      });
      if (item.type === 'agent_message') {
        out.finalResponse = item.text;
      }
    } else if (event.type === 'turn.completed') {
      out.usage = event.usage;
    } else if (event.type === 'turn.failed') {
      out.turnFailed = event.error?.message;
    } else if (event.type === 'error') {
      out.errors.push(event.message);
    }
  }
} catch (error) {
  out.error = String(error?.stack ?? error).slice(0, 3000);
}
out.wallMs = Date.now() - started;
out.aborted = abort.aborted;
let finalParsed;
try {
  finalParsed = out.finalResponse ? JSON.parse(out.finalResponse) : undefined;
} catch {
  finalParsed = undefined;
}
out.finalParsed = finalParsed;
out.finalSchemaOk =
  finalParsed !== undefined &&
  ['complete', 'incomplete'].includes(finalParsed.run_status) &&
  Number.isInteger(finalParsed.finding_count) &&
  Object.keys(finalParsed).length === 2;
out.report = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;
out.schemaProblems = out.report ? validateReport(out.report) : ['no submit_findings report'];
out.mcpCalls = existsSync(`${outPath}.calls.json`)
  ? JSON.parse(readFileSync(`${outPath}.calls.json`, 'utf8'))
  : [];
out.reportSchemaKeys = Object.keys(reportSchema.properties);
writeFileSync(`${codexHome}/done`, '1');
console.log(JSON.stringify({ engineResult: out }));
