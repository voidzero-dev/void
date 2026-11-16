import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { connectEventStream } from '../../src/runtime/sse/client.ts';
import {
  eventStream,
  formatSse,
  formatSseText,
  getLastEventId,
  SseStreamClosedError,
  type SseStream,
} from '../../src/runtime/sse/index.ts';
import { MockEventSource } from '../helpers/mock-event-source.ts';

const decoder = new TextDecoder();
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

async function readResponseText(response: Response): Promise<string> {
  return await response.text();
}

describe('formatSse', () => {
  it('serializes id, event, retry, object data, and string data', () => {
    expect(
      formatSse({
        id: 'evt_1',
        event: 'post.update',
        retry: 1000,
        data: { id: '123', likes: 10 },
      }),
    ).toBe('id: evt_1\nevent: post.update\nretry: 1000\ndata: {"id":"123","likes":10}\n\n');

    expect(formatSse({ data: 'hello' })).toBe('data: hello\n\n');
  });

  it('splits multi-line data into multiple data fields', () => {
    expect(formatSse({ event: 'log', data: 'one\ntwo\r\nthree' })).toBe(
      'event: log\ndata: one\ndata: two\ndata: three\n\n',
    );
  });

  it('rejects invalid control fields, retry values, binary data, and circular objects', () => {
    expect(() => formatSse({ event: 'ok\ndata: injected' })).toThrow('event must not contain');
    expect(() => formatSse({ retry: 1.5 })).toThrow('retry must be a non-negative integer');
    expect(() => formatSse({ data: new Uint8Array([1]) })).toThrow('binary data is not supported');
    expect(() => formatSse({ data: new Blob(['hello']) })).toThrow('binary data is not supported');
    expect(() => formatSse({ data: new File(['hello'], 'hello.txt') })).toThrow(
      'binary data is not supported',
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatSse({ data: circular })).toThrow('data must be JSON-serializable');
  });
});

describe('formatSseText', () => {
  it('formats already-serialized string data without JSON serialization', () => {
    expect(
      formatSseText({
        id: 'evt_1',
        event: 'post.update',
        data: '{"id":"123","likes":10}',
      }),
    ).toBe('id: evt_1\nevent: post.update\ndata: {"id":"123","likes":10}\n\n');
  });

  it('uses the same control-field validation as formatSse', () => {
    expect(() => formatSseText({ id: 'bad\nid', data: 'hello' })).toThrow('id must not contain');
  });
});

describe('eventStream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts pending writes without waiting for the client to read', async () => {
    const controller = new AbortController();
    let stream!: SseStream;
    let pending!: Promise<void>;
    const response = eventStream(
      (value) => {
        stream = value;
        pending = value.send({ data: 'unread' });
        return pending;
      },
      { signal: controller.signal, keepAlive: false },
    );
    await Promise.resolve();
    const rejected = expect(pending).rejects.toBeInstanceOf(SseStreamClosedError);
    controller.abort(new Error('cancelled'));
    await rejected;
    await stream.closed;
    expect(stream.signal.aborted).toBe(true);
    await expect(response.text()).rejects.toThrow('cancelled');
  });

  it('returns SSE headers and closes finite streams when start returns', async () => {
    const response = eventStream(
      async (stream) => {
        await stream.comment('connected');
        await stream.send({ event: 'ready', data: { ok: true } });
      },
      { keepAlive: false },
    );

    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    expect(await readResponseText(response)).toBe(
      ': connected\n\nevent: ready\ndata: {"ok":true}\n\n',
    );
  });

  it('emits keepalives by default and disables them with keepAlive false', async () => {
    vi.useFakeTimers();

    const response = eventStream((stream) => stream.closed, {
      keepAlive: { intervalMs: 10, comment: 'ping' },
    });
    const reader = response.body!.getReader();

    await vi.advanceTimersByTimeAsync(10);
    const chunk = await reader.read();
    expect(decoder.decode(chunk.value)).toBe(': ping\n\n');
    await reader.cancel();

    const disabled = eventStream(
      async (stream) => {
        await stream.send({ data: 'done' });
      },
      { keepAlive: false },
    );
    expect(await readResponseText(disabled)).toBe('data: done\n\n');
  });

  it('resolves closed on cancellation and rejects writes after close', async () => {
    let captured: SseStream | undefined;
    const response = eventStream((stream) => {
      captured = stream;
      return stream.closed;
    });
    await Promise.resolve();

    const reader = response.body!.getReader();
    await reader.cancel();
    await expect(captured!.closed).resolves.toBeUndefined();
    await expect(captured!.send({ data: 'late' })).rejects.toBeInstanceOf(SseStreamClosedError);
  });

  it('does not swallow send validation errors', async () => {
    let sendError: unknown;
    await readResponseText(
      eventStream(
        async (stream) => {
          try {
            await stream.send({ id: 'bad\nid', data: 'nope' });
          } catch (error) {
            sendError = error;
          }
        },
        { keepAlive: false },
      ),
    );

    expect(sendError).toBeInstanceOf(Error);
    expect((sendError as Error).message).toContain('id must not contain');
  });
});

describe('getLastEventId', () => {
  it('reads the Last-Event-ID header', () => {
    expect(
      getLastEventId(
        new Request('https://void.test/events', { headers: { 'Last-Event-ID': '42' } }),
      ),
    ).toBe('42');
  });
});

describe('connectEventStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  });

  it('parses JSON events and unregisters listeners', () => {
    const stream = connectEventStream<{ ready: { ok: boolean } }>('/events', {
      withCredentials: true,
    });
    const source = MockEventSource.instances[0]!;
    const handler = vi.fn();
    const off = stream.on('ready', handler);

    expect(source.url).toBe('/events');
    expect(source.options?.withCredentials).toBe(true);

    source.emit('ready', '{"ok":true}', 'evt_1');
    expect(handler).toHaveBeenCalledWith({
      data: { ok: true },
      event: 'ready',
      id: 'evt_1',
      raw: { data: '{"ok":true}', lastEventId: 'evt_1' },
    });

    off();
    source.emit('ready', '{"ok":false}', 'evt_2');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports text parsing, error listeners, and close', () => {
    const stream = connectEventStream('/events', { parse: 'text' });
    const source = MockEventSource.instances[0]!;
    const messageHandler = vi.fn();
    const errorHandler = vi.fn();

    stream.on('log', messageHandler);
    const offError = stream.onError(errorHandler);
    source.emit('log', 'hello');
    source.emit('error', { type: 'error' } as Event);
    offError();
    source.emit('error', { type: 'error' } as Event);
    stream.close();

    expect(messageHandler.mock.calls[0]?.[0].data).toBe('hello');
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });
});
