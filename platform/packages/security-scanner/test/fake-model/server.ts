// Fake model server for runner tests (and later the S2/S3 local parts and the
// Docker recorded runs). Serves scripted replies in order and records every
// request. Replies: JSON (chat completions), SSE (Messages / Responses / chat
// streams), a bare status with headers (proxy stops), a dropped connection, or no
// answer at all.

import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeReply =
  | { json: unknown; status?: number; headers?: Record<string, string> }
  | { sse: Array<{ event?: string; data: unknown }>; status?: number }
  | { status: number; headers?: Record<string, string>; text?: string }
  | { hangUp: true }
  /** Never answers (a hung model call); `close()` drops it. */
  | { hold: true };

export type RecordedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

export type FakeModel = {
  url: string;
  requests: Array<RecordedRequest>;
  /** Replies not used yet. */
  remaining(): number;
  close(): Promise<void>;
};

export type FakeScript =
  | Array<FakeReply>
  | ((request: RecordedRequest, index: number) => FakeReply);

export async function startFakeModel(script: FakeScript): Promise<FakeModel> {
  const requests: Array<RecordedRequest> = [];
  const queue = Array.isArray(script) ? [...script] : null;
  const server: Server = createServer(async (req, res) => {
    const recorded = await record(req);
    requests.push(recorded);
    const reply = queue
      ? queue.shift()
      : (script as Exclude<FakeScript, Array<FakeReply>>)(recorded, requests.length - 1);
    if (reply === undefined) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('fake model: no scripted reply');
      return;
    }
    if ('hold' in reply) {
      return;
    }
    if ('hangUp' in reply) {
      req.socket.destroy();
      return;
    }
    if ('json' in reply) {
      res
        .writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
        .end(JSON.stringify(reply.json));
      return;
    }
    if ('sse' in reply) {
      res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream' });
      for (const event of reply.sse) {
        const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
        res.write(`${event.event ? `event: ${event.event}\n` : ''}data: ${data}\n\n`);
      }
      res.end();
      return;
    }
    res.writeHead(reply.status, reply.headers).end(reply.text ?? '');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    remaining: () => queue?.length ?? 0,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function record(req: IncomingMessage): Promise<RecordedRequest> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text.
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }
  return { method: req.method ?? 'GET', path: req.url ?? '/', headers, body };
}

let callCounter = 0;

/** A chat-completions answer that calls tools. */
export function chatToolCalls(
  calls: Array<{ name: string; arguments: unknown }>,
  usage = { prompt_tokens: 100, completion_tokens: 20 },
): FakeReply {
  return {
    json: {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((call) => ({
              id: `call_${++callCounter}`,
              type: 'function',
              function: {
                name: call.name,
                arguments:
                  typeof call.arguments === 'string'
                    ? call.arguments
                    : JSON.stringify(call.arguments),
              },
            })),
          },
        },
      ],
      usage,
    },
  };
}

export function chatToolCall(name: string, args: unknown): FakeReply {
  return chatToolCalls([{ name, arguments: args }]);
}

/** A chat-completions answer in plain text. */
export function chatText(text: string, finishReason = 'stop'): FakeReply {
  return {
    json: {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      choices: [
        { index: 0, finish_reason: finishReason, message: { role: 'assistant', content: text } },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    },
  };
}
