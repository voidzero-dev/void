import { expect, it, vi } from 'vite-plus/test';
import {
  createWebSocketDurableObject,
  createWebSocketTombstoneDurableObject,
} from '../../src/runtime/ws-server.ts';
import { defineRoom, defineWebSocket, type WebSocketBaseContext } from '../../src/runtime/ws.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const schema: StandardSchemaV1 = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};
const route = { pattern: '/chat', params: [], className: 'ChatWs', bindingName: 'CHAT_WS' };
const state = { storage: {}, getWebSockets: () => [] } as unknown as DurableObjectState;

function socket(readyState = 2) {
  const close = vi.fn();
  const webSocket = {
    readyState,
    close,
    deserializeAttachment: () => ({
      id: 'connection',
      roomId: 'room',
      params: { room: 'room' },
      user: null,
    }),
  } as unknown as WebSocket;
  return { webSocket, close };
}

function define(
  kind: 'room' | 'socket',
  definition: {
    messages: { client: StandardSchemaV1; server: StandardSchemaV1 };
    onClose: (
      context: WebSocketBaseContext,
      details?: { code: number; reason: string; wasClean: boolean },
    ) => void;
  },
) {
  return kind === 'room' ? defineRoom(definition) : defineWebSocket(definition);
}

it.each(['room', 'socket'] as const)(
  'completes the close handshake before invoking %s hooks',
  async (kind) => {
    const { webSocket, close } = socket();
    const onClose = vi.fn(
      (_context: unknown, details?: { code: number; reason: string; wasClean: boolean }) => {
        expect(close).toHaveBeenCalledWith(1000, 'done');
        expect(details).toEqual({ code: 1000, reason: 'done', wasClean: true });
      },
    );
    const DurableObject = createWebSocketDurableObject(
      define(kind, { messages: { client: schema, server: schema }, onClose }),
      route,
    );
    await new DurableObject(state, {}).webSocketClose(webSocket, 1000, 'done', true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);

it('completes the handshake even when the user close hook rejects', async () => {
  const { webSocket, close } = socket();
  const error = new Error('close hook failed');
  const DurableObject = createWebSocketDurableObject(
    defineWebSocket({
      messages: { client: schema, server: schema },
      onClose: () => {
        throw error;
      },
    }),
    route,
  );
  await expect(
    new DurableObject(state, {}).webSocketClose(webSocket, 1000, 'done', true),
  ).rejects.toBe(error);
  expect(close).toHaveBeenCalledWith(1000, 'done');
});

it.each([1004, 1005, 1006, 1015])(
  'does not send reserved close code %i back to the peer',
  async (code) => {
    const { webSocket, close } = socket();
    const onClose = vi.fn();
    const DurableObject = createWebSocketDurableObject(
      defineWebSocket({
        messages: { client: schema, server: schema },
        onClose,
      }),
      route,
    );
    await new DurableObject(state, {}).webSocketClose(webSocket, code, '', false);
    expect(close).toHaveBeenCalledWith();
    expect(onClose).toHaveBeenCalledWith(expect.anything(), { code, reason: '', wasClean: false });
  },
);

it('does not close an already closed socket again and still invokes its hook', async () => {
  const { webSocket, close } = socket(3);
  const onClose = vi.fn();
  const DurableObject = createWebSocketDurableObject(
    defineWebSocket({
      messages: { client: schema, server: schema },
      onClose,
    }),
    route,
  );
  await new DurableObject(state, {}).webSocketClose(webSocket, 1006, '', false);
  expect(close).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it('also completes close handshakes for removed WebSocket routes', async () => {
  const { webSocket, close } = socket();
  const DurableObject = createWebSocketTombstoneDurableObject('RemovedWs');
  await new DurableObject(state, {}).webSocketClose(webSocket, 1000, 'done', true);
  expect(close).toHaveBeenCalledWith(1000, 'done');
});
