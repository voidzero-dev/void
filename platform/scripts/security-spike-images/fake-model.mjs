// Scripted fake model for security audits spikes S2/S3 (no real model, no spend).
//
// One plain module with no imports, so the same code runs in the local Node server
// (fake-model-server.mjs) and is inlined into the live spike controller Worker.
// It answers Anthropic Messages (Engine A, Claude Agent SDK) and OpenAI Responses
// (Engine C, Codex SDK) with a fixed script of "rounds":
//   round 0: escape attempts (shell, write, read outside /scan/input, web) + a listing
//   round 1: grep + read of the seeded file
//   round 2: submit the finding (StructuredOutput / submit_findings), line taken from
//            the read result the engine sent back
//   round 3: final answer (Codex: JSON that matches --output-schema)
// Tool-call ids carry the round (`r<round>_<n>`), so the next round is read from the
// conversation the engine sends, with no server state.

export const PLANT_MARKER = 'VOID-SPIKE-PLANTED';
export const SEEDED_FILE = 'src/routes/api/notes.ts';
export const SEEDED_NEEDLE = "WHERE owner = '";

function lineOf(text, needle) {
  // Read results come back as "  12\tcode" (Claude) or plain text with our own
  // "12: code" prefix (void-scan MCP). Return the number at the start of the hit line.
  for (const raw of String(text).split('\n')) {
    if (!raw.includes(needle)) {
      continue;
    }
    let digits = '';
    for (const ch of raw.trimStart()) {
      if (ch >= '0' && ch <= '9') {
        digits += ch;
      } else {
        break;
      }
    }
    return digits ? Number(digits) : 0;
  }
  return 0;
}

export function seededFinding(line) {
  return {
    run_status: 'complete',
    findings: [
      {
        title: 'SQL injection in the notes query',
        severity: 'critical',
        class: 'sql_injection',
        file: SEEDED_FILE,
        line,
        evidence: 'owner from the query string is concatenated into the D1 SQL text',
        status: 'confirmed',
      },
    ],
  };
}

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

function roundOf(id) {
  // ids look like toolu_r1_0 / call_r1_0
  const at = String(id).indexOf('_r');
  if (at < 0) {
    return -1;
  }
  const rest = String(id).slice(at + 2);
  const end = rest.indexOf('_');
  const n = Number(end < 0 ? rest : rest.slice(0, end));
  return Number.isInteger(n) ? n : -1;
}

// ---------- shared request summary (what the spike records; never a header value) ----------

// Tools come in body.tools, or (Codex "responses lite") in an `additional_tools` input
// item; both may group them in namespaces. Names are reported as "<namespace>.<tool>".
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
        out.push({
          type: inner.type ?? tool.type,
          name: `${tool.name}.${inner.name}`,
          namespace: tool.name,
          inner: inner.name,
          description: String(inner.description ?? '').slice(0, 120),
        });
      }
    } else {
      out.push({
        type: tool.type,
        name: tool.name ?? tool.type,
        description: String(tool.description ?? '').slice(0, 120),
      });
    }
  }
  return out;
}

export function summarizeRequest({ method, path, headers, bodyText }) {
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { unparsed: bodyText.length };
  }
  const tools = flattenTools(body);
  const auth = headers.authorization ?? '';
  const apiKey = headers['x-api-key'] ?? '';
  return {
    method,
    path,
    headerNames: Object.keys(headers).sort(),
    // Only shapes, never values: the container must hold nothing worth recording.
    authorization: auth
      ? auth.includes('placeholder')
        ? 'placeholder'
        : `other(${auth.length})`
      : 'none',
    xApiKey: apiKey
      ? apiKey.includes('placeholder')
        ? 'placeholder'
        : `other(${apiKey.length})`
      : 'none',
    userAgent: (headers['user-agent'] ?? '').slice(0, 80),
    originator: headers.originator,
    model: body.model,
    stream: body.stream,
    bodyKeys: Object.keys(body).sort(),
    tools,
    store: body.store,
    include: body.include,
    promptCacheKey: body.prompt_cache_key !== undefined,
    parallelToolCalls: body.parallel_tool_calls,
    accessPrograms: body.access_programs,
    textFormat: body.text?.format?.type,
    textFormatStrict: body.text?.format?.strict,
    instructionsBytes: typeof body.instructions === 'string' ? body.instructions.length : undefined,
    systemBytes: body.system ? textOf(body.system).length : undefined,
    plantedMarkerInRequest: bodyText.includes(PLANT_MARKER),
    // What the engine sent back for the scripted round-0 escape attempts (Codex).
    toolOutputs: (Array.isArray(body.input) ? body.input : [])
      .filter(
        (item) =>
          String(item.type).endsWith('_output') && String(item.call_id).startsWith('call_r0_'),
      )
      .map((item) => ({ callId: item.call_id, output: textOf(item.output).slice(0, 160) })),
    toolCalls: (Array.isArray(body.input) ? body.input : [])
      .filter((item) => item.type === 'function_call' || item.type === 'custom_tool_call')
      .map((item) => ({
        callId: item.call_id,
        name: item.namespace ? `${item.namespace}.${item.name}` : item.name,
      })),
    bodyBytes: bodyText.length,
  };
}

// ---------- Anthropic Messages (Engine A) ----------

function sse(events) {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

function anthropicMessage(blocks, stopReason, stream) {
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
  if (!stream) {
    return {
      status: 200,
      contentType: 'application/json',
      text: JSON.stringify({
        ...message,
        content: blocks,
        stop_reason: stopReason,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    };
  }
  const events = [['message_start', { type: 'message_start', message }]];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(
        [
          'content_block_start',
          { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
        ],
      );
    } else {
      events.push(
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          },
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          },
        ],
      );
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 50 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  );
  return { status: 200, contentType: 'text/event-stream', text: sse(events) };
}

function anthropicReply(body) {
  const names = (body.tools ?? []).map((t) => t.name);
  if (!names.includes('Read')) {
    // Side request (title, summary, classifier): answer plainly.
    return anthropicMessage([{ type: 'text', text: 'ok' }], 'end_turn', body.stream);
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
  const toolUse = (n, name, input) => ({
    type: 'tool_use',
    id: `toolu_r${round}_${n}`,
    name,
    input,
  });
  if (round === 0) {
    const calls = [
      toolUse(0, 'Bash', {
        command: 'touch /tmp/pwned-bash; curl -s https://example.com',
        description: 'spike',
      }),
      toolUse(1, 'Read', { file_path: '/etc/passwd' }),
      toolUse(2, 'Read', { file_path: '/scan/input/../../etc/hostname' }),
      toolUse(3, 'Write', { file_path: '/scan/input/pwned.txt', content: 'x' }),
      toolUse(4, 'WebFetch', { url: 'https://example.com/', prompt: 'x' }),
      toolUse(5, 'Glob', { pattern: '**/*', path: '/scan/input' }),
      toolUse(6, 'Grep', { pattern: 'root', path: '/etc' }),
    ];
    if (names.includes('Skill')) {
      calls.push(
        toolUse(7, 'Skill', { skill: 'evil' }),
        toolUse(8, 'Skill', { skill: 'doctor' }),
        toolUse(11, 'Skill', { skill: 'plugin-authoring' }),
        toolUse(12, 'Skill', { skill: 'void-security:void-security-review' }),
      );
    }
    if (names.includes('DeferredToolPlaceholder')) {
      calls.push(toolUse(9, 'DeferredToolPlaceholder', {}));
    }
    calls.push(toolUse(10, 'ToolSearch', { query: 'select:Bash' }));
    return anthropicMessage(calls, 'tool_use', body.stream);
  }
  if (round === 1) {
    return anthropicMessage(
      [
        toolUse(0, 'Grep', {
          pattern: 'SELECT',
          path: '/scan/input',
          output_mode: 'content',
          '-n': true,
        }),
        toolUse(1, 'Read', { file_path: `/scan/input/${SEEDED_FILE}` }),
      ],
      'tool_use',
      body.stream,
    );
  }
  if (round === 2) {
    const read = results.get('toolu_r1_1') ?? '';
    const output =
      names.find((n) => n === 'StructuredOutput') ??
      names.find((n) => n.toLowerCase().includes('output'));
    const finding = seededFinding(lineOf(read, SEEDED_NEEDLE));
    if (!output) {
      return anthropicMessage(
        [{ type: 'text', text: JSON.stringify(finding) }],
        'end_turn',
        body.stream,
      );
    }
    return anthropicMessage([toolUse(0, output, finding)], 'tool_use', body.stream);
  }
  return anthropicMessage([{ type: 'text', text: 'Review complete.' }], 'end_turn', body.stream);
}

// ---------- OpenAI Responses (Engine C) ----------

function responsesStream(items) {
  const id = `resp_${Date.now()}`;
  const events = [['response.created', { type: 'response.created', response: { id } }]];
  items.forEach((item, index) => {
    events.push(
      [
        'response.output_item.added',
        { type: 'response.output_item.added', output_index: index, item },
      ],
      [
        'response.output_item.done',
        { type: 'response.output_item.done', output_index: index, item },
      ],
    );
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
  return { status: 200, contentType: 'text/event-stream', text: sse(events) };
}

function responsesReply(body) {
  const tools = flattenTools(body);
  const find = (name) =>
    tools.find((t) => t.namespace === 'mcp__void_scan' && t.inner === name) ??
    tools.find((t) => t.inner === name || t.name === name);
  let last = -1;
  const outputs = new Map();
  for (const item of body.input ?? []) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      last = Math.max(last, roundOf(item.call_id));
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      outputs.set(item.call_id, textOf(item.output));
    }
  }
  const round = last + 1;
  const call = (n, tool, args) => {
    const item = {
      type: 'function_call',
      id: `fc_r${round}_${n}`,
      call_id: `call_r${round}_${n}`,
      status: 'completed',
      arguments: JSON.stringify(args),
    };
    if (tool && tool.namespace && tool.namespace !== 'functions') {
      return { ...item, name: tool.inner, namespace: tool.namespace };
    }
    if (tool && tool.inner) {
      return { ...item, name: tool.inner };
    }
    return { ...item, name: tool ? tool.name : String(tool) };
  };
  const raw = (n, name, args) => ({
    type: 'function_call',
    id: `fc_r${round}_${n}`,
    call_id: `call_r${round}_${n}`,
    status: 'completed',
    name,
    arguments: JSON.stringify(args),
  });
  const custom = (n, name, input) => ({
    type: 'custom_tool_call',
    id: `ctc_r${round}_${n}`,
    call_id: `call_r${round}_${n}`,
    status: 'completed',
    name,
    input,
  });
  if (round === 0) {
    const items = [
      raw(0, 'shell', { command: ['bash', '-lc', 'touch /tmp/pwned-shell'] }),
      raw(1, 'exec_command', { cmd: 'touch /tmp/pwned-exec' }),
      raw(2, 'shell_command', { command: 'touch /tmp/pwned-shell-command' }),
      custom(
        3,
        'apply_patch',
        '*** Begin Patch\n*** Add File: /work/pwned.txt\n+x\n*** End Patch\n',
      ),
      custom(4, 'exec', 'await tools.exec_command({ cmd: "touch /tmp/pwned-code-mode" });'),
    ];
    const read = find('read_file');
    const list = find('list_files');
    if (read) {
      items.push(
        call(5, read, { path: '/etc/passwd' }),
        call(6, read, { path: '/scan/input/../../etc/hostname' }),
      );
    }
    if (list) {
      items.push(call(7, list, { path: '/scan/input' }));
    }
    items.push(
      raw(8, 'view_image', { path: '/etc/passwd' }),
      raw(9, 'spawn_agent', { message: 'touch /tmp/pwned-agent' }),
    );
    const resource = find('read_mcp_resource');
    if (resource) {
      items.push(call(10, resource, { server: 'void-scan', uri: 'file:///etc/passwd' }));
    }
    const ask = find('request_user_input');
    if (ask) {
      items.push(
        call(11, ask, {
          questions: [{ id: 'q', header: 'q', question: 'run a shell?', options: [] }],
        }),
      );
    }
    items.push(raw(12, 'mcp__void_scan__read_file', { path: '/etc/passwd' }));
    return responsesStream(items);
  }
  if (round === 1) {
    const grep = find('grep');
    const read = find('read_file');
    const items = [];
    if (grep) {
      items.push(call(0, grep, { pattern: 'SELECT', path: '/scan/input' }));
    }
    if (read) {
      items.push(call(1, read, { path: `/scan/input/${SEEDED_FILE}` }));
    }
    if (items.length) {
      return responsesStream(items);
    }
  }
  if (round === 2) {
    const submit = find('submit_findings');
    const finding = seededFinding(lineOf(outputs.get('call_r1_1') ?? '', SEEDED_NEEDLE));
    if (submit) {
      return responsesStream([call(0, submit, finding)]);
    }
  }
  const finding = seededFinding(lineOf(outputs.get('call_r1_1') ?? '', SEEDED_NEEDLE));
  const final = { run_status: 'complete', finding_count: finding.findings.length };
  return responsesStream([
    {
      type: 'message',
      id: `msg_r${round}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(final), annotations: [] }],
    },
  ]);
}

/**
 * Answer one request. Returns { status, contentType, text, delayMs? }.
 * Prompt markers for the stop tests: VOID-SPIKE-HANG (answer only after 10 min, so the
 * runner's kill must end the run) and VOID-SPIKE-402 (a proxy refusal for credits).
 */
export function fakeModel({ method, path, bodyText }) {
  if (bodyText.includes('VOID-SPIKE-HANG')) {
    return { status: 200, contentType: 'application/json', text: '{}', delayMs: 600_000 };
  }
  if (bodyText.includes('VOID-SPIKE-402')) {
    return {
      status: 402,
      contentType: 'application/json',
      text: JSON.stringify({
        error: {
          message: 'Insufficient unified billing credits',
          code: 2021,
          type: 'insufficient_credits',
        },
      }),
    };
  }
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return { status: 400, contentType: 'application/json', text: '{"error":"bad json"}' };
  }
  if (method === 'POST' && path.includes('/messages/count_tokens')) {
    return { status: 200, contentType: 'application/json', text: '{"input_tokens":100}' };
  }
  if (method === 'POST' && path.includes('/messages')) {
    return anthropicReply(body);
  }
  if (method === 'POST' && path.includes('/responses')) {
    return responsesReply(body);
  }
  if (path.endsWith('/models')) {
    return {
      status: 200,
      contentType: 'application/json',
      text: '{"object":"list","data":[],"models":[]}',
    };
  }
  return {
    status: 404,
    contentType: 'application/json',
    text: '{"error":"fake model: unknown route"}',
  };
}
