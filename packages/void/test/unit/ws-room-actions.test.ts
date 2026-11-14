import { describe, expect, it, vi } from 'vite-plus/test';
import { getRoom } from '../../src/runtime/ws-room.ts';
import {
  createWebSocketDurableObject,
  forwardWebSocketRequest,
  __registerWebSocketRoutes,
} from '../../src/runtime/ws-server.ts';
import { defineRoom, defineWebSocket } from '../../src/runtime/ws.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const schema: StandardSchemaV1 = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};
const messages = { client: schema, server: schema };
const route = {
  pattern: '/relay/:accountId',
  params: ['accountId'],
  className: 'RelayWs',
  bindingName: 'RELAY_WS',
  mode: 'room' as const,
};

const getRoomLoose = getRoom as unknown as (
  path: string,
  options?: { params?: Record<string, string>; env?: Record<string, unknown> },
) => { actions: Record<string, (...args: Array<unknown>) => Promise<unknown>> };

function createEnv(
  handler: (request: {
    name: string;
    args: Array<unknown>;
    id: string;
    params: Record<string, string>;
  }) => Promise<unknown>,
) {
  const keys: Array<string> = [];
  const env = {
    RELAY_WS: {
      idFromName(name: string) {
        keys.push(name);
        return name;
      },
      get: () => ({ __voidRoomAction: handler }),
    },
  };
  return { env, keys };
}

describe('server-side room actions', () => {
  it('accepts bracket patterns and custom instance keys', async () => {
    const key = ({ params }: { params: Record<string, string> }) => `account=${params.id}`;
    const keyedRoute = { ...route, pattern: '/rooms/:id', params: ['id'], key };
    __registerWebSocketRoutes([keyedRoute]);
    const { env, keys } = createEnv(async () => null);

    await getRoomLoose('/rooms/[id]', { params: { id: 'acct_1' }, env }).actions.revokeSession('s');

    const clientKeys: Array<string> = [];
    await forwardWebSocketRequest(
      new Request('https://app.test/rooms/acct_1'),
      {
        RELAY_WS: {
          idFromName(name: string) {
            clientKeys.push(name);
            return name;
          },
          get: () => ({ fetch: async () => new Response('ok') }),
        },
      },
      keyedRoute,
    );

    expect(keys).toEqual(['account=acct_1']);
    expect(clientKeys).toEqual(keys);
  });

  it('addresses catch-all patterns by their public spelling', async () => {
    const named = { ...route, pattern: '/files/:path{.+}', params: ['path'] };
    __registerWebSocketRoutes([named]);
    const { env, keys } = createEnv(async () => null);

    await getRoomLoose('/files/[...path]', { params: { path: 'a/b' }, env }).actions.sync();
    expect(keys).toEqual(['path=a/b']);

    __registerWebSocketRoutes([{ ...route, pattern: '/*', params: [] }]);
    await getRoomLoose('/[...]', { env }).actions.sync();
    expect(keys).toEqual(['path=a/b', 'default']);
  });

  it('is not thenable, so awaiting it never dispatches an action named "then"', async () => {
    __registerWebSocketRoutes([route]);
    const calls: Array<string> = [];
    const { env } = createEnv(async (request) => {
      calls.push(request.name);
      throw new Error(`unexpected action "${request.name}"`);
    });
    const room = getRoomLoose('/relay/:accountId', { params: { accountId: 'acct_1' }, env });

    await expect(Promise.resolve(room.actions)).resolves.toBe(room.actions);
    await expect((async () => room.actions)()).resolves.toBe(room.actions);
    expect(calls).toEqual([]);
  });

  it('rejects unknown routes, socket routes and missing params', () => {
    __registerWebSocketRoutes([
      route,
      {
        pattern: '/feed',
        params: [],
        className: 'FeedWs',
        bindingName: 'FEED_WS',
        mode: 'socket',
      },
    ]);
    const { env } = createEnv(async () => null);

    expect(() => getRoomLoose('/missing', { env })).toThrow('Unknown WebSocket route');
    expect(() => getRoomLoose('/feed', { env })).toThrow('defineRoom() route');
    expect(() => getRoomLoose('/relay/:accountId', { params: {}, env })).toThrow(
      'Missing route param "accountId"',
    );
  });

  it('needs a runtime env or an explicit one', () => {
    __registerWebSocketRoutes([route]);
    expect(() => getRoomLoose('/relay/:accountId', { params: { accountId: 'a' } })).toThrow(
      'getRoom() needs a runtime env',
    );
    expect(() =>
      getRoomLoose('/relay/:accountId', { params: { accountId: 'a' }, env: {} }),
    ).toThrow('Missing Durable Object binding "RELAY_WS"');
  });
});

describe('room action dispatch inside the Durable Object', () => {
  const state = {} as unknown as DurableObjectState;
  const definition = defineRoom({
    messages,
    actions: {
      fail() {
        throw new Error('deliberate failure');
      },
    },
  });
  const DurableObject = createWebSocketDurableObject(definition, route);
  const instance = new DurableObject(state, {});

  it('reports unknown actions and handler errors', async () => {
    await expect(
      instance.__voidRoomAction!({ name: 'missing', args: [], id: 'id', params: {} }),
    ).rejects.toThrow('Unknown room action "missing"');
    await expect(
      instance.__voidRoomAction!({ name: 'constructor', args: [], id: 'id', params: {} }),
    ).rejects.toThrow('Unknown room action "constructor"');
    await expect(
      instance.__voidRoomAction!({ name: 'fail', args: [], id: 'id', params: {} }),
    ).rejects.toThrow('deliberate failure');
  });

  it('keeps socket routes out of actions', async () => {
    const SocketObject = createWebSocketDurableObject(defineWebSocket({ messages }), {
      ...route,
      pattern: '/feed',
      params: [],
      className: 'FeedWs',
      bindingName: 'FEED_WS',
    });

    await expect(
      new SocketObject(state, {}).__voidRoomAction!({
        name: 'revokeSession',
        args: ['s'],
        id: 'default',
        params: {},
      }),
    ).rejects.toThrow('Unknown room action "revokeSession"');
  });
});
