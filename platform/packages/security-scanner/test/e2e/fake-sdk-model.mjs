// Scripted model for the Docker recorded run: `node fake-sdk-model.mjs <port> <log.jsonl>`
// inside the scanner container (built-ins only, 127.0.0.1). It answers Anthropic Messages
// (Engine A) and OpenAI Responses (Engine C). Each session plays rounds read from the tool
// call ids: 0 reads the seeded file and /etc/passwd, 1 submits the report, 2 ends.
// It logs one JSON line per request: tools offered, planted text or credential seen, and
// the /etc/passwd answer.

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PLANT_MARKER = 'VOID-E2E-PLANTED';
const SEEDED_FILE = 'src/routes/api/notes.ts';
const SEEDED_NEEDLE = "WHERE owner = '";

const [port, logPath] = process.argv.slice(2);

/** @returns {string} */
function textOf(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => textOf(part)).join('\n');
  }
  return value && typeof value === 'object'
    ? textOf(value.text ?? value.content ?? value.output ?? '')
    : '';
}

/** Tool call ids look like `toolu_r1_0` / `call_r1_0`. */
function roundOf(id) {
  const text = String(id);
  const at = text.indexOf('_r');
  const round = at < 0 ? Number.NaN : Number.parseInt(text.slice(at + 2), 10);
  return Number.isInteger(round) ? round : -1;
}

/** The line number of the needle in a read result ("4\tcode" or "     4\tcode"). */
function lineOf(text) {
  const raw = String(text)
    .split('\n')
    .find((line) => line.includes(SEEDED_NEEDLE));
  const line = raw === undefined ? Number.NaN : Number.parseInt(raw.trimStart(), 10);
  return Number.isInteger(line) ? line : 1;
}

function report(line) {
  const at = { file: SEEDED_FILE, line_start: line, line_end: line };
  const trace = [{ file: SEEDED_FILE, line, note: 'owner from the query reaches the SQL' }];
  return {
    run_status: 'complete',
    findings: [
      {
        ...at,
        fingerprint: 'sqli-notes-owner',
        verdict: 'confirmed',
        severity: 'critical',
        title: 'SQL injection in the notes query',
        category: 'sql_injection',
        cwe: 'CWE-89',
        sink_path: 'c.env.DB.prepare',
        trace,
        evidence: 'owner is concatenated into the D1 SQL text',
        fix: 'bind owner as a parameter',
      },
    ],
  };
}

/** SSE events, each `[type, fields]`; the data repeats the type. */
function sse(events) {
  const text = events
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    .join('');
  return { status: 200, type: 'text/event-stream', text };
}

// ---------- Anthropic Messages (Engine A) ----------

const STOP_NONE = { stop_reason: null, stop_sequence: null };

function anthropicMessage(blocks, stopReason) {
  const usage = { input_tokens: 100, output_tokens: 1 };
  const message = { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', usage };
  const events = [
    ['message_start', { message: { ...message, ...STOP_NONE, model: 'fake-model', content: [] } }],
  ];
  blocks.forEach((block, index) => {
    const text = block.type === 'text';
    const start = text
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: block.id, name: block.name, input: {} };
    const delta = text
      ? { type: 'text_delta', text: block.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
    events.push(
      ['content_block_start', { index, content_block: start }],
      ['content_block_delta', { index, delta }],
      ['content_block_stop', { index }],
    );
  });
  events.push(
    [
      'message_delta',
      { delta: { ...STOP_NONE, stop_reason: stopReason }, usage: { output_tokens: 50 } },
    ],
    ['message_stop', {}],
  );
  return sse(events);
}

function anthropicReply(body, entry) {
  entry.tools = (body.tools ?? []).map((tool) => String(tool.name));
  if (!entry.tools.includes('Read')) {
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
  entry.passwd = results.get('toolu_r0_1')?.slice(0, 200);
  const toolUse = (n, name, input) => ({
    type: 'tool_use',
    id: `toolu_r${round}_${n}`,
    name,
    input,
  });
  if (round === 0) {
    const read = (file_path, n) => toolUse(n, 'Read', { file_path });
    return anthropicMessage(
      [read(`/scan/input/${SEEDED_FILE}`, 0), read('/etc/passwd', 1)],
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
  const groups = [...(body.tools ?? [])];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item.type === 'additional_tools') {
      groups.push(...(item.tools ?? []));
    }
  }
  /** @type {Array<{ name: string, namespace?: string, inner: string }>} */
  const out = [];
  for (const tool of groups) {
    const name = String(tool.name ?? tool.type);
    for (const inner of Array.isArray(tool.tools) ? tool.tools : [null]) {
      out.push(
        inner
          ? { name: `${name}.${inner.name}`, namespace: name, inner: String(inner.name) }
          : { name, inner: name },
      );
    }
  }
  return out;
}

function responsesStream(items) {
  const id = `resp_${Date.now()}`;
  const usage = {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 150,
  };
  return sse([
    ['response.created', { response: { id } }],
    ...items.flatMap((item, output_index) => [
      ['response.output_item.added', { output_index, item }],
      ['response.output_item.done', { output_index, item }],
    ]),
    ['response.completed', { response: { id, output: items, usage } }],
  ]);
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
  entry.passwd = outputs.get('call_r0_1')?.slice(0, 200);
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
  const text = JSON.stringify({ run_status: 'complete', finding_count: 1 });
  const content = [{ type: 'output_text', text, annotations: [] }];
  return responsesStream([
    { type: 'message', id: `msg_r${round}`, role: 'assistant', status: 'completed', content },
  ]);
}

function credentialShape(value) {
  return !value ? 'none' : value.includes('placeholder') ? 'placeholder' : 'other';
}

function json(text, status = 200) {
  return { status, type: 'application/json', text };
}

function answer(method, path, bodyText, entry) {
  if (path.startsWith('/v1/void/last-failure')) {
    return json('{"failure":null}');
  }
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return json('{"error":"bad json"}', 400);
  }
  if (method === 'POST' && path.includes('/messages/count_tokens')) {
    return json('{"input_tokens":100}');
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
    return json('{"object":"list","data":[],"models":[]}');
  }
  return json('{"error":"fake model: unknown route"}', 404);
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
