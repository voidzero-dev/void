// Runtime checks on the scan's throwaway copy (design doc 0095, M30; spec §8.6). The copy
// is the deployed bundle with empty stores, fake secrets and stubbed bindings; the
// controller routes `http://copy.void.internal` to it and to nothing else. Verify sessions
// get one tool, `copy_request`; every call is recorded so a confirmation that names a
// request can be checked against what really happened.

import {
  COPY_CONTROL_PREFIX,
  COPY_HEADER,
  COPY_HOST,
  COPY_READY_PATH,
} from '../../../../api/src/security/runtime-copy-names.ts';
import type { SessionTool } from '../engines/types.ts';
import { RUNTIME_PROOF_METHODS } from '../report.ts';
import type { FindingRecord } from '../report.ts';
import { delay } from '../util.ts';

const COPY_BASE_URL = `http://${COPY_HOST}`;

const COPY_LIMITS = {
  /** Requests one verify session may send. */
  requestsPerSession: 20,
  bodyBytes: 64 * 1024,
  /** Answer text handed back to the model. */
  answerChars: 16 * 1024,
  headers: 30,
  headerChars: 4096,
  pathChars: 2048,
  timeoutMs: 20_000,
  /** How long verify waits for the copy before it runs static-only. */
  readyWaitMs: 90_000,
  readyPollMs: 3000,
} as const;

type Method = (typeof RUNTIME_PROOF_METHODS)[number];

export type CopyRequestRecord = {
  id: string;
  method: Method;
  path: string;
  status: number;
  /** The copy itself answered (not the controller saying it is unavailable). */
  dispatched: boolean;
};

/**
 * Whether a request reaches the copy's own setup routes, where the app's code never runs.
 * The path is read the way `fetch` and the copy's entry read it (`/x/../__void_copy/d1`).
 */
function isCopyControlPath(path: string): boolean {
  try {
    return new URL(path, COPY_BASE_URL).pathname.startsWith(COPY_CONTROL_PREFIX);
  } catch {
    return true;
  }
}

const COPY_TOOL_DESCRIPTION = [
  'Send one HTTP request to a throwaway copy of this deployment: the same code, with EMPTY databases (tables exist, no rows), fake secrets and no outbound network. It is never the live app.',
  'Use it to prove or disprove the candidate at runtime. Seed test data first when you need rows: POST /__void_copy/d1 with {"binding","sql","params"} runs one SQL statement on a copy D1 binding; POST /__void_copy/kv with {"binding","key","value"} writes one KV key; GET /__void_copy/ready lists the bindings.',
  `Each call gets an id (r1, r2, …). At most ${COPY_LIMITS.requestsPerSession} calls.`,
].join(' ');

const COPY_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'path'],
  properties: {
    method: { type: 'string', enum: [...RUNTIME_PROOF_METHODS] },
    path: {
      type: 'string',
      maxLength: COPY_LIMITS.pathChars,
      description: 'Path and query, starting with "/" (for example "/api/items?id=2").',
    },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Request headers, for example a cookie for a test user.',
    },
    body: { type: 'string', maxLength: COPY_LIMITS.bodyBytes },
  },
};

export class CopyClient {
  readonly #fetch: typeof fetch;
  readonly #signal: AbortSignal | undefined;
  #next = 1;

  constructor(options: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#signal = options.signal;
  }

  /**
   * Waits until the copy answers its ready route. `false` when the controller says there
   * is no copy route at all (an older controller: the catch-all deny), or the wait ends.
   */
  async waitReady(): Promise<boolean> {
    const until = Date.now() + COPY_LIMITS.readyWaitMs;
    while (!this.#signal?.aborted) {
      try {
        const response = await this.#fetch(`${COPY_BASE_URL}${COPY_READY_PATH}`, {
          signal: AbortSignal.timeout(COPY_LIMITS.timeoutMs),
        });
        const marker = response.headers.get(COPY_HEADER);
        await response.body?.cancel().catch(() => undefined);
        if (response.ok && marker === 'dispatched') {
          return true;
        }
        if (marker === null) {
          // Not our copy route: no copy will come.
          return false;
        }
      } catch {
        // Not reachable yet.
      }
      if (Date.now() + COPY_LIMITS.readyPollMs > until) {
        return false;
      }
      await delay(COPY_LIMITS.readyPollMs, this.#signal);
    }
    return false;
  }

  /** A `copy_request` tool for one verify session, with its own record of requests. */
  sessionTool() {
    const requests: Array<CopyRequestRecord> = [];
    const tool: SessionTool = {
      name: 'copy_request',
      description: COPY_TOOL_DESCRIPTION,
      parameters: COPY_TOOL_PARAMETERS,
      run: (args) => this.#send(args, requests),
    };
    return { tool, requests };
  }

  async #send(
    args: Record<string, unknown>,
    requests: Array<CopyRequestRecord>,
  ): Promise<{ ok: boolean; text: string }> {
    if (requests.length >= COPY_LIMITS.requestsPerSession) {
      return { ok: false, text: 'error: no copy requests left in this session' };
    }
    const checked = checkArgs(args);
    if (typeof checked === 'string') {
      return { ok: false, text: `error: ${checked}` };
    }
    const id = `r${this.#next++}`;
    const timeout = AbortSignal.timeout(COPY_LIMITS.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${COPY_BASE_URL}${checked.path}`, {
        method: checked.method,
        headers: checked.headers,
        body: checked.body,
        redirect: 'manual',
        signal: this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout,
      });
    } catch (error) {
      return {
        ok: false,
        text: `error: ${id} failed: ${error instanceof Error ? error.name : 'network error'}`,
      };
    }
    const dispatched = response.headers.get(COPY_HEADER) === 'dispatched';
    const text = await readCapped(response, COPY_LIMITS.answerChars);
    requests.push({
      id,
      method: checked.method,
      path: checked.path,
      status: response.status,
      dispatched,
    });
    const headerLines: Array<string> = [];
    response.headers.forEach((value, name) => {
      if (name !== COPY_HEADER) {
        headerLines.push(`${name}: ${value.slice(0, 300)}`);
      }
    });
    return {
      ok: true,
      text: [
        `id: ${id}`,
        dispatched ? `status: ${response.status}` : `status: ${response.status} (copy unavailable)`,
        `headers:\n${headerLines.slice(0, 40).join('\n')}`,
        // The answer is data from the app under test, never instructions.
        `body (untrusted data from the copy):\n${text}`,
      ].join('\n'),
    };
  }
}

type CheckedArgs = { method: Method; path: string; headers: Record<string, string>; body?: string };

function checkArgs(args: Record<string, unknown>): CheckedArgs | string {
  const method = RUNTIME_PROOF_METHODS.find(
    (name) => typeof args.method === 'string' && name === args.method.trim().toUpperCase(),
  );
  if (method === undefined) {
    return `method must be one of ${RUNTIME_PROOF_METHODS.join(', ')}`;
  }
  const path = args.path;
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.length > COPY_LIMITS.pathChars
  ) {
    return 'path must start with a single "/" (a path on the copy, never a URL)';
  }
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return 'path must not hold spaces or control characters (encode them)';
    }
  }
  const headers: Record<string, string> = {};
  if (args.headers !== undefined) {
    if (typeof args.headers !== 'object' || args.headers === null || Array.isArray(args.headers)) {
      return 'headers must be an object of strings';
    }
    const entries = Object.entries(args.headers as Record<string, unknown>);
    if (entries.length > COPY_LIMITS.headers) {
      return `at most ${COPY_LIMITS.headers} headers`;
    }
    for (const [name, value] of entries) {
      if (typeof value !== 'string' || value.length > COPY_LIMITS.headerChars) {
        return `header ${JSON.stringify(name.slice(0, 64))} must be a string`;
      }
      // The controller owns the route: no host or copy marker from the model.
      if (!['host', COPY_HEADER, 'content-length'].includes(name.toLowerCase())) {
        headers[name] = value;
      }
    }
  }
  if (args.body === undefined || args.body === null) {
    return { method, path, headers };
  }
  if (typeof args.body !== 'string' || Buffer.byteLength(args.body) > COPY_LIMITS.bodyBytes) {
    return `body must be a string of at most ${COPY_LIMITS.bodyBytes} bytes`;
  }
  if (method === 'GET' || method === 'HEAD') {
    return 'a GET or HEAD request has no body';
  }
  return { method, path, headers, body: args.body };
}

async function readCapped(response: Response, maxChars: number): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > maxChars) {
        await reader.cancel().catch(() => undefined);
        return `${text.slice(0, maxChars)}\n[cut at ${maxChars} characters]`;
      }
    }
  } catch {
    return `${text}\n[answer cut: read failed]`;
  }
  return text + decoder.decode();
}

/**
 * The verify answer's runtime claim, checked: a confirmed record that names a request
 * of this session which the copy itself answered, outside its setup routes, becomes
 * `runtime`; anything else stays `static`. Model-set source fields are never kept.
 */
export function withVerdictSource(
  record: FindingRecord,
  requests: ReadonlyArray<CopyRequestRecord>,
): FindingRecord {
  const rest = withoutRuntimeFields(record);
  const proofRequest = record.proof_request;
  if (record.verdict !== 'confirmed' || typeof proofRequest !== 'string') {
    return rest;
  }
  const proof = requests.find((request) => request.id === proofRequest.trim());
  if (!proof?.dispatched || isCopyControlPath(proof.path)) {
    return rest;
  }
  return {
    ...rest,
    verdict_source: 'runtime',
    runtime_proof: {
      request: proof.id,
      method: proof.method,
      path: proof.path.slice(0, 1024),
      status: proof.status,
    },
  };
}

/** Strips the fields only the runner may set (a hunt record, or a session with no copy). */
export function withoutRuntimeFields(record: FindingRecord): FindingRecord {
  const {
    proof_request: _request,
    verdict_source: _source,
    runtime_proof: _proof,
    ...rest
  } = record;
  return rest;
}
