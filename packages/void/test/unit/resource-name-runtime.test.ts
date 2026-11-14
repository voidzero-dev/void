import { describe, expect, it, vi } from 'vite-plus/test';
import { defineDurableState } from '../../src/runtime/durable.ts';
import {
  buildWebSocketInstanceId,
  createWebSocketDurableObject,
  forwardWebSocketRequest,
} from '../../src/runtime/ws-server.ts';
import { defineRoom, defineWebSocket } from '../../src/runtime/ws.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const schema: StandardSchemaV1 = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};
const messages = { client: schema, server: schema };
const route = {
  pattern: '/chat/:room',
  params: ['room'],
  className: 'ChatRoomWs',
  bindingName: 'ChatRoomWs',
};

describe('persistent resource runtime contracts', () => {
  it('requires generated Durable State metadata to match the authored name', () => {
    const state = defineDurableState({ name: 'counter', initialState: 0, methods: {} });
    expect(() => state.__bind('COUNTER')).toThrow('statically discoverable');
    expect(() => state.__bind('COUNTER', 'different')).toThrow('statically discoverable');
    expect(() => state.__bind('COUNTER', 'counter')).not.toThrow();
    expect(() =>
      defineDurableState({ initialState: 0, methods: {} }).__bind('COUNTER'),
    ).not.toThrow();
  });

  it.each(['room', 'socket'] as const)(
    'requires generated WebSocket metadata to match the authored %s name',
    (kind) => {
      const define = (definition: { name?: string; messages: typeof messages }) =>
        kind === 'room' ? defineRoom(definition) : defineWebSocket(definition);
      const definition = define({ name: 'chat-room', messages });
      expect(() => createWebSocketDurableObject(definition, route)).toThrow(
        'statically discoverable',
      );
      expect(() =>
        createWebSocketDurableObject(definition, { ...route, name: 'different' }),
      ).toThrow('statically discoverable');
      expect(() =>
        createWebSocketDurableObject(definition, { ...route, name: 'chat-room' }),
      ).not.toThrow();
      expect(() => createWebSocketDurableObject(define({ messages }), route)).not.toThrow();
    },
  );

  it.each(['', '---', '123', '123-counter'])(
    'rejects invalid explicit names %j at runtime',
    (name) => {
      expect(() => defineDurableState({ name, initialState: 0, methods: {} })).toThrow('name');
      expect(() => defineRoom({ name, messages })).toThrow('name');
      expect(() => defineWebSocket({ name, messages })).toThrow('name');
    },
  );

  it('keeps existing default instance keys and ordering', () => {
    expect(buildWebSocketInstanceId({ params: [] }, {})).toBe('default');
    expect(buildWebSocketInstanceId(route, { room: 'general' })).toBe('room=general');
    expect(
      buildWebSocketInstanceId({ params: ['team', 'room'] }, { room: 'general', team: 'a' }),
    ).toBe('team=a&room=general');
  });

  it('allows a renamed parameter to keep its old instance key', () => {
    const key = ({ params }: { params: Record<string, string> }) => `room=${params.id}`;
    expect(buildWebSocketInstanceId({ params: ['id'], key }, { id: 'general' })).toBe(
      'room=general',
    );
  });

  it('isolates ambiguous multi-parameter rooms without reusing legacy storage', async () => {
    const keys: Array<string> = [];
    const multiRoute = { ...route, pattern: '/teams/:team/rooms/:room', params: ['team', 'room'] };
    const env = {
      [route.bindingName]: {
        idFromName(name: string) {
          keys.push(name);
          return name;
        },
        get: () => ({ fetch: async () => new Response('ok') }),
      },
    };
    for (const path of ['/teams/a%26room%3Db/rooms/c', '/teams/a/rooms/b%26room%3Dc']) {
      await forwardWebSocketRequest(new Request(`https://app.test${path}`), env, multiRoute);
    }
    expect(new Set(keys).size).toBe(2);
    expect(keys).not.toContain('team=a&room=b&room=c');
    expect(keys[0]).toBe(buildWebSocketInstanceId(multiRoute, { team: 'a&room=b', room: 'c' }));
    expect(keys[1]).toBe(buildWebSocketInstanceId(multiRoute, { team: 'a', room: 'b&room=c' }));
    expect(buildWebSocketInstanceId(multiRoute, { team: 'a', room: 'b%26room%3Dc' })).toBe(
      'team=a&room=b%26room%3Dc',
    );
    expect(buildWebSocketInstanceId(route, { room: 'a&b=東京' })).toBe('room=a&b=東京');
  });

  it('rejects asynchronous or nonstring keys before selecting a namespace instance', () => {
    for (const key of [() => Promise.resolve('room=general'), () => 1]) {
      expect(() =>
        buildWebSocketInstanceId({ params: ['id'], key: key as never }, { id: 'general' }),
      ).toThrow('synchronously');
    }
  });
});
