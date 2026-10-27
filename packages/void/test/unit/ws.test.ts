import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { connect } from '../../src/runtime/ws.ts';

declare module 'void/routes' {
  interface WebSocketRouteMap {
    '/chat/:room': {
      params: { room: string };
      client: { type: 'chat.message'; text: string };
      server: { type: 'chat.message'; text: string };
    };
    '/notifications': {
      params: Record<string, never>;
      client: { type: 'notifications.ack'; id: string };
      server: { type: 'notifications.item'; title: string };
    };
    '/files/:path{.+}': {
      params: { path: string };
      client: unknown;
      server: unknown;
    };
  }
}

class MockWebSocket {
  static instances: Array<MockWebSocket> = [];
  static readonly OPEN = 1;

  readyState = 0;
  sent: Array<string> = [];
  readonly listeners = new Map<string, Set<(event: MockSocketEvent) => void>>();

  constructor(
    readonly url: string,
    readonly protocols?: string | Array<string>,
  ) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MockSocketEvent) => void) {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(listener);
    this.listeners.set(type, handlers);
  }

  emit(type: string, event: MockSocketEvent = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string) {
    this.emit('close', { code, reason, wasClean: true });
  }
}

type MockSocketEvent = {
  data?: string;
  code?: number;
  reason?: string;
  wasClean?: boolean;
};

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
const originalLocation = (globalThis as { location?: unknown }).location;

describe('typed websocket client', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('location', { href: 'https://void.test/app' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    (globalThis as { location?: unknown }).location = originalLocation;
  });

  it('expands complete catch-all tokens', () => {
    connect('/files/:path{.+}', { params: { path: 'docs/start here' } });
    expect(MockWebSocket.instances[0]!.url).toBe('wss://void.test/files/docs/start%20here');
  });

  it('keeps a secure wss baseURL secure', () => {
    connect('/notifications', { baseURL: 'wss://api.example.com' });
    expect(MockWebSocket.instances[0]!.url).toBe('wss://api.example.com/notifications');
  });

  it('uses ws for an http baseURL', () => {
    connect('/notifications', { baseURL: 'http://localhost:5173' });
    expect(MockWebSocket.instances[0]!.url).toBe('ws://localhost:5173/notifications');
  });

  it('buffers messages until the socket opens', () => {
    const socket = connect('/chat/:room', { params: { room: 'general' } });
    const ws = MockWebSocket.instances[0]!;

    socket.send({ type: 'chat.message', text: 'hello' });
    expect(ws.sent).toEqual([]);

    ws.readyState = MockWebSocket.OPEN;
    ws.emit('open');

    expect(ws.sent).toEqual([JSON.stringify({ type: 'chat.message', text: 'hello' })]);
  });

  it('parses incoming messages for subscribers', () => {
    const socket = connect('/notifications');
    const ws = MockWebSocket.instances[0]!;
    const handler = vi.fn();
    socket.on('message', handler);

    ws.emit('message', { data: JSON.stringify({ type: 'notifications.item', title: 'done' }) });

    expect(handler).toHaveBeenCalledWith({ type: 'notifications.item', title: 'done' });
  });
  describe('reconnect', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reconnects after the server drops the socket', () => {
      connect('/notifications', { reconnectDelayMs: 50 });
      MockWebSocket.instances[0]!.emit('close', { code: 1006, wasClean: false });

      vi.advanceTimersByTime(50);

      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it('does not reconnect when closed during the reconnect delay', () => {
      const socket = connect('/notifications', { reconnectDelayMs: 50 });
      MockWebSocket.instances[0]!.emit('close', { code: 1006, wasClean: false });

      socket.close(1000, 'unmount');
      vi.advanceTimersByTime(1_000);

      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });
});
