// Scripted model for the Docker recorded run (test/e2e/recorded-run.e2e.test.ts). Plain
// Node, no imports beyond built-ins: it runs inside the scanner container next to the
// engine (the container has no network, so it listens on 127.0.0.1).
//
//   node fake-sdk-model.mjs <port> <log.jsonl>
//
// It answers what the real SDKs send: Anthropic Messages (Engine A, Claude Agent SDK) and
// OpenAI Responses (Engine C, Codex SDK). Every hunt or verify session plays the same two
// rounds, read from the conversation the engine sends back (tool call ids carry the round):
//   round 0: read the seeded file, and try /etc/passwd (the engine must refuse it)
//   round 1: hand in the report (StructuredOutput / submit_findings) with the seeded finding
//   round 2: Codex only: the final message its --output-schema asks for
// One JSON line per request goes to the log: tool names, whether a planted marker or a
// credential reached the model, and what the engine answered for /etc/passwd.

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

export const PLANT_MARKER = 'VOID-E2E-PLANTED';
export const SEEDED_FILE = 'src/routes/api/notes.ts';
const SEEDED_NEEDLE = "WHERE owner = '";

const [port, logPath] = process.argv.slice(2);

function textOf(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => textOf(part)).join('\n');
  }
  if (value && typeof value === 'object') {
    return textOf(value.text ?? value.content ?? value.output ?? '');
  }
  return '';
}

/** Tool call ids look like `toolu_r1_0` / `call_r1_0`. */
function roundOf(id) {
  const text = String(id);
  const at = text.indexOf('_r');
  if (at < 0) {
    return -1;
  }
  const rest = text.slice(at + 2);
  const end = rest.indexOf('_');
  const round = Number(end < 0 ? rest : rest.slice(0, end));
  return Number.isInteger(round) ? round : -1;
}

/** The line number of the needle in a read result ("4\tcode" or "     4\tcode"). */
function lineOf(text) {
  for (const raw of String(text).split('\n')) {
    if (!raw.includes(SEEDED_NEEDLE)) {
      continue;
    }
    let digits = '';
    for (const char of raw.trimStart()) {
      if (char >= '0' && char <= '9') {
        digits += char;
      } else {
        break;
      }
    }
    return digits ? Number(digits) : 1;
  }
  return 1;
}

function report(line) {
  return {
    run_status: 'complete',
    notes: 'fake model',
    findings: [
      {
        fingerprint: 'sqli-notes-owner',
        verdict: 'confirmed',
        severity: 'critical',
        confidence: 'high',
        title: 'SQL injection in the notes query',
        category: 'sql_injection',
        cwe: 'CWE-89',
        file: SEEDED_FILE,
        line_start: line,
        line_end: line,
        sink_path: 'c.env.DB.prepare',
        outside_diff: false,
        trace: [
          { file: SEEDED_FILE, line, note: 'owner from the query string reaches the SQL text' },
        ],
        evidence: 'owner is concatenated into the D1 SQL text',
        conditions: 'none',
        fix: 'bind owner as a parameter',
        reason: 'source to sink in one function',
      },
    ],
  };
}

function sse(events) {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

// ---------- Anthropic Messages (Engine A) ----------

function anthropicMessage(blocks, stopReason) {
  const message = {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: 'fake-model',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 1 },
  };
  const events = [['message_start', { type: 'message_start', message }]];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push([
        'content_block_start',
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      ]);
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
      ]);
    } else {
      events.push([
        'content_block_start',
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
      ]);
      events.push([
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 50 },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return { status: 200, type: 'text/event-stream', text: sse(events) };
}

function anthropicReply(body, entry) {
  const names = (body.tools ?? []).map((tool) => tool.name);
  entry.tools = names;
  if (!names.includes('Read')) {
    // A side request (title, classifier): answer plainly.
    return anthropicMessage([{ type: 'text', text: 'ok' }], 'end_turn');
  }
  let last = -1;
  const results = new Map();
  for (const message of body.messages ?? []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') {
        last = Math.max(last, roundOf(block.id));
      }
      if (block.type === 'tool_result') {
        results.set(block.tool_use_id, textOf(block.content));
      }
    }
  }
  const round = last + 1;
  if (results.has('toolu_r0_1')) {
    entry.passwd = results.get('toolu_r0_1').slice(0, 200);
  }
  const toolUse = (n, name, input) => ({
    type: 'tool_use',
    id: `toolu_r${round}_${n}`,
    name,
    input,
  });
  if (round === 0) {
    return anthropicMessage(
      [
        toolUse(0, 'Read', { file_path: `/scan/input/${SEEDED_FILE}` }),
        toolUse(1, 'Read', { file_path: '/etc/passwd' }),
      ],
      'tool_use',
    );
  }
  if (round === 1) {
    const line = lineOf(results.get('toolu_r0_0') ?? '');
    return anthropicMessage([toolUse(0, 'StructuredOutput', report(line))], 'tool_use');
  }
  return anthropicMessage([{ type: 'text', text: 'Review complete.' }], 'end_turn');
}

// ---------- OpenAI Responses (Engine C) ----------

/** Tools in body.tools (maybe in namespaces), named "<namespace>.<tool>". */
function flattenTools(body) {
  const out = [];
  const groups = [...(body.tools ?? [])];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item.type === 'additional_tools') {
      groups.push(...(item.tools ?? []));
    }
  }
  for (const tool of groups) {
    if (Array.isArray(tool.tools)) {
      for (const inner of tool.tools) {
        out.push({ name: `${tool.name}.${inner.name}`, namespace: tool.name, inner: inner.name });
      }
    } else {
      out.push({ name: tool.name ?? tool.type, inner: tool.name ?? tool.type });
    }
  }
  return out;
}

function responsesStream(items) {
  const id = `resp_${Date.now()}`;
  const events = [['response.created', { type: 'response.created', response: { id } }]];
  items.forEach((item, index) => {
    events.push([
      'response.output_item.added',
      { type: 'response.output_item.added', output_index: index, item },
    ]);
    events.push([
      'response.output_item.done',
      { type: 'response.output_item.done', output_index: index, item },
    ]);
  });
  events.push([
    'response.completed',
    {
      type: 'response.completed',
      response: {
        id,
        output: items,
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 150,
        },
      },
    },
  ]);
  return { status: 200, type: 'text/event-stream', text: sse(events) };
}

function responsesReply(body, entry) {
  const tools = flattenTools(body);
  entry.tools = tools.map((tool) => tool.name);
  const find = (name) =>
    tools.find((tool) => tool.namespace === 'mcp__void_scan' && tool.inner === name) ??
    tools.find((tool) => tool.inner === name);
  let last = -1;
  const outputs = new Map();
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item.type === 'function_call') {
      last = Math.max(last, roundOf(item.call_id));
    }
    if (item.type === 'function_call_output') {
      outputs.set(item.call_id, textOf(item.output));
    }
  }
  const round = last + 1;
  if (outputs.has('call_r0_1')) {
    entry.passwd = outputs.get('call_r0_1').slice(0, 200);
  }
  const call = (n, tool, args) => ({
    type: 'function_call',
    id: `fc_r${round}_${n}`,
    call_id: `call_r${round}_${n}`,
    status: 'completed',
    name: tool.inner,
    ...(tool.namespace && tool.namespace !== 'functions' ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(args),
  });
  const read = find('read_file');
  const submit = find('submit_findings');
  if (round === 0 && read) {
    return responsesStream([
      call(0, read, { path: `/scan/input/${SEEDED_FILE}` }),
      call(1, read, { path: '/etc/passwd' }),
    ]);
  }
  if (round === 1 && submit) {
    return responsesStream([call(0, submit, report(lineOf(outputs.get('call_r0_0') ?? '')))]);
  }
  return responsesStream([
    {
      type: 'message',
      id: `msg_r${round}`,
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: JSON.stringify({ run_status: 'complete', finding_count: 1 }),
          annotations: [],
        },
      ],
    },
  ]);
}

function credentialShape(value) {
  if (!value) {
    return 'none';
  }
  return value.includes('placeholder') ? 'placeholder' : 'other';
}

function answer(method, path, bodyText, entry) {
  if (path.startsWith('/v1/void/last-failure')) {
    return { status: 200, type: 'application/json', text: '{"failure":null}' };
  }
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return { status: 400, type: 'application/json', text: '{"error":"bad json"}' };
  }
  if (method === 'POST' && path.includes('/messages/count_tokens')) {
    return { status: 200, type: 'application/json', text: '{"input_tokens":100}' };
  }
  if (method === 'POST' && path.includes('/messages')) {
    entry.api = 'messages';
    return anthropicReply(body, entry);
  }
  if (method === 'POST' && path.includes('/responses')) {
    entry.api = 'responses';
    return responsesReply(body, entry);
  }
  if (path.endsWith('/models')) {
    return {
      status: 200,
      type: 'application/json',
      text: '{"object":"list","data":[],"models":[]}',
    };
  }
  return { status: 404, type: 'application/json', text: '{"error":"fake model: unknown route"}' };
}

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '/';
    const entry = {
      method: request.method,
      path,
      planted: bodyText.includes(PLANT_MARKER),
      authorization: credentialShape(request.headers.authorization),
      apiKey: credentialShape(request.headers['x-api-key']),
      session: request.headers['x-void-scan-session'] ?? null,
    };
    const reply = answer(request.method, path, bodyText, entry);
    entry.status = reply.status;
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    response.writeHead(reply.status, { 'content-type': reply.type });
    response.end(reply.text);
  });
}).listen(Number(port), '127.0.0.1', () => {
  appendFileSync(logPath, `${JSON.stringify({ listening: Number(port) })}\n`);
});
