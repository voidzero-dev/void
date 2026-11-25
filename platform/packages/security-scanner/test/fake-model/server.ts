// Fake model server for runner tests: serves scripted chat-completions replies in
// order and records every request.

import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeReply = { json: unknown };

export type RecordedRequest = { path: string; headers: Record<string, string>; body: unknown };

export type FakeModel = { url: string; requests: Array<RecordedRequest>; close(): Promise<void> };

export async function startFakeModel(script: Array<FakeReply>): Promise<FakeModel> {
  const requests: Array<RecordedRequest> = [];
  const queue = [...script];
  const server: Server = createServer(async (req, res) => {
    requests.push(await record(req));
    const reply = queue.shift();
    if (reply === undefined) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('fake model: no scripted reply');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.json));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
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
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }
  return { path: req.url ?? '/', headers, body: text ? JSON.parse(text) : null };
}

let callCounter = 0;

/** A chat-completions answer that calls tools. */
export function chatToolCalls(calls: Array<{ name: string; arguments: unknown }>): FakeReply {
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
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    },
  };
}

export function chatToolCall(name: string, args: unknown): FakeReply {
  return chatToolCalls([{ name, arguments: args }]);
}
