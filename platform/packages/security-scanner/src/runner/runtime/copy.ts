// Runtime checks on the scan's throwaway copy (design doc 0095, M30; spec §8.6). The copy
// is the deployed bundle with empty stores, fake secrets and stubbed bindings; the
// controller routes `http://copy.void.internal` to it and to nothing else. Verify sessions
// get one tool, `copy_request`; every call is recorded so a confirmation that names a
// request can be checked against what really happened.

import type { SessionTool } from '../engines/types.ts';
import { RUNTIME_PROOF_METHODS, type FindingRecord } from '../report.ts';

export const COPY_BASE_URL = 'http://copy.void.internal';
export const COPY_HEADER = 'x-void-copy';
export const COPY_READY_PATH = '/__void_copy/ready';
/** Routes the copy's own entry answers before the app runs (ready check, test rows). */
export const COPY_CONTROL_PREFIX = '/__void_copy/';

export const COPY_LIMITS = {
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
  readyPollMs: 3_000,
} as const;

type Method = (typeof RUNTIME_PROOF_METHODS)[number];

export type CopyRequestRecord = {
  id: string;
  method: Method;
  path: string;
  status: number;
  /** The copy itself answered (not the controller saying it is unavailable). */
  dispatched: boolean;
  /** A copy setup route (`/__void_copy/…`): the app's code never ran, so never proof. */
  control: boolean;
};

/**
 * Whether a request reaches the copy's own setup routes. The path is read the way
 * `fetch` and the copy's entry read it (`/x/../__void_copy/d1` included).
 */
export function isCopyControlPath(path: string): boolean {
  try {
    return new URL(path, COPY_BASE_URL).pathname.startsWith(COPY_CONTROL_PREFIX);
  } catch {
    return true;
  }
}

export type CopyClientOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Tests shorten the ready wait. */
  readyWaitMs?: number;
  readyPollMs?: number;
};

export class CopyClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #options: CopyClientOptions;
  #next = 1;

  constructor(options: CopyClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? COPY_BASE_URL;
    this.#fetch = options.fetch ?? fetch;
    this.#options = options;
  }

  /**
   * Waits until the copy answers its ready route. `false` when the controller says there
   * is no copy route at all (an older controller: the catch-all deny), or the wait ends.
   */
  async waitReady(): Promise<boolean> {
    const waitMs = this.#options.readyWaitMs ?? COPY_LIMITS.readyWaitMs;
    const pollMs = this.#options.readyPollMs ?? COPY_LIMITS.readyPollMs;
    const until = Date.now() + waitMs;
    for (;;) {
      if (this.#options.signal?.aborted) {
        return false;
      }
      try {
        const response = await this.#fetch(`${this.#baseUrl}${COPY_READY_PATH}`, {
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
      if (Date.now() + pollMs > until) {
        return false;
      }
      await delay(pollMs, this.#options.signal);
    }
  }

  /** A `copy_request` tool for one verify session, with its own record of requests. */
  sessionTool(): { tool: SessionTool; requests: Array<CopyRequestRecord> } {
    const requests: Array<CopyRequestRecord> = [];
    const tool: SessionTool = {
      name: 'copy_request',
      description: [
        'Send one HTTP request to a throwaway copy of this deployment: the same code, with EMPTY databases (tables exist, no rows), fake secrets and no outbound network. It is never the live app.',
        'Use it to prove or disprove the candidate at runtime. Seed test data first when you need rows: POST /__void_copy/d1 with {"binding","sql","params"} runs one SQL statement on a copy D1 binding; POST /__void_copy/kv with {"binding","key","value"} writes one KV key; GET /__void_copy/ready lists the bindings.',
        `Each call gets an id (r1, r2, …). At most ${COPY_LIMITS.requestsPerSession} calls.`,
      ].join(' '),
      parameters: {
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
      },
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
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${checked.path}`, {
        method: checked.method,
        headers: checked.headers,
        ...(checked.body !== undefined ? { body: checked.body } : {}),
        redirect: 'manual',
        signal: this.#options.signal
          ? AbortSignal.any([this.#options.signal, AbortSignal.timeout(COPY_LIMITS.timeoutMs)])
          : AbortSignal.timeout(COPY_LIMITS.timeoutMs),
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
      control: isCopyControlPath(checked.path),
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

type CheckedArgs = {
  method: Method;
  path: string;
  headers: Record<string, string>;
  body?: string;
};

function checkArgs(args: Record<string, unknown>): CheckedArgs | string {
  const method = typeof args.method === 'string' ? args.method.trim().toUpperCase() : '';
  if (!(RUNTIME_PROOF_METHODS as ReadonlyArray<string>).includes(method)) {
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
      const lower = name.toLowerCase();
      // The controller owns the route: no host or copy marker from the model.
      if (lower === 'host' || lower === COPY_HEADER || lower === 'content-length') {
        continue;
      }
      headers[name] = value;
    }
  }
  if (args.body !== undefined && args.body !== null) {
    if (typeof args.body !== 'string' || Buffer.byteLength(args.body) > COPY_LIMITS.bodyBytes) {
      return `body must be a string of at most ${COPY_LIMITS.bodyBytes} bytes`;
    }
    if (method === 'GET' || method === 'HEAD') {
      return 'a GET or HEAD request has no body';
    }
    return { method: method as Method, path, headers, body: args.body };
  }
  return { method: method as Method, path, headers };
}

async function readCapped(response: Response, maxChars: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
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
  if (!proof || !proof.dispatched || proof.control || isCopyControlPath(proof.path)) {
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
