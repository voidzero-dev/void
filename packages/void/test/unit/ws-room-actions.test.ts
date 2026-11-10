import { describe, expect, it, vi } from 'vite-plus/test';
import { getRoom } from '../../src/runtime/ws-room.ts';
import {
  buildWebSocketInstanceId,
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

type Attachment = { id: string; state?: unknown };

function createState(attachments: Array<Attachment>) {
  const sockets = attachments.map((attachment) => ({
    close: vi.fn(),
    deserializeAttachment: () => attachment,
    serializeAttachment: () => {},
    readyState: 1,
    send: vi.fn(),
  }));
  return {
    sockets,
    state: {
      storage: { get: vi.fn(), put: vi.fn() },
      getWebSockets: () => sockets,
    } as unknown as DurableObjectState,
  };
}

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
  it('addresses the instance a client connects to and returns the action result', async () => {
    __registerWebSocketRoutes([route]);
    const calls: Array<{
      name: string;
      args: Array<unknown>;
      id: string;
      params: Record<string, string>;
    }> = [];
    const { env, keys } = createEnv(async (request) => {
      calls.push(request);
      return { closed: 1 };
    });

    const room = getRoomLoose('/relay/:accountId', { params: { accountId: 'acct_1' }, env });
    expect(calls).toEqual([]);

    await expect(room.actions.revokeSession('session_1', 4001)).resolves.toEqual({ closed: 1 });

    const clientKeys: Array<string> = [];
    await forwardWebSocketRequest(
      new Request('https://app.test/relay/acct_1'),
      {
        RELAY_WS: {
          idFromName(name: string) {
            clientKeys.push(name);
            return name;
          },
          get: () => ({ fetch: async () => new Response('ok') }),
        },
      },
      route,
    );

    expect(keys).toEqual([buildWebSocketInstanceId(route, { accountId: 'acct_1' })]);
    expect(clientKeys).toEqual(keys);
    expect(calls).toEqual([
      {
        name: 'revokeSession',
        args: ['session_1', 4001],
        id: 'accountId=acct_1',
        params: { accountId: 'acct_1' },
      },
    ]);
  });

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

  it('surfaces unknown actions thrown inside the room', async () => {
    __registerWebSocketRoutes([route]);
    const { env } = createEnv(async (request) => {
      throw new Error(`ws: Unknown room action "${request.name}".`);
    });

    await expect(
      getRoomLoose('/relay/:accountId', { params: { accountId: 'a' }, env }).actions.revokeSession(
        's',
      ),
    ).rejects.toThrow('Unknown room action "revokeSession"');
  });
});

describe('room action dispatch inside the Durable Object', () => {
  const { state, sockets } = createState([
    { id: 'connection-1', state: { sessionId: 'session_1' } },
    { id: 'connection-2', state: { sessionId: 'session_2' } },
  ]);
  const definition = defineRoom({
    messages,
    actions: {
      revokeSession(context, sessionId: string, code: number) {
        let closed = 0;
        for (const connection of context.room.getConnections()) {
          if ((connection.state as { sessionId?: string } | undefined)?.sessionId === sessionId) {
            connection.close(code, 'revoked');
            closed += 1;
          }
        }
        return { closed, id: context.id, params: context.params };
      },
      fail() {
        throw new Error('deliberate failure');
      },
    },
  });
  const DurableObject = createWebSocketDurableObject(definition, route);
  const instance = new DurableObject(state, {});

  it('closes only the matching connections with the action context', async () => {
    await expect(
      instance.__voidRoomAction!({
        name: 'revokeSession',
        args: ['session_1', 4001],
        id: 'accountId=acct_1',
        params: { accountId: 'acct_1' },
      }),
    ).resolves.toEqual({ closed: 1, id: 'accountId=acct_1', params: { accountId: 'acct_1' } });

    expect(sockets[0]!.close).toHaveBeenCalledWith(4001, 'revoked');
    expect(sockets[1]!.close).not.toHaveBeenCalled();
  });

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

  it('does not invoke actions from client messages', async () => {
    const action = vi.fn();
    const onMessage = vi.fn();
    const RoomObject = createWebSocketDurableObject(
      defineRoom({ messages, actions: { revokeSession: action }, onMessage }),
      route,
    );
    const room = new RoomObject(state, {});

    await room.webSocketMessage(
      sockets[0] as unknown as WebSocket,
      JSON.stringify({ action: 'revokeSession', args: ['session_1'] }),
    );

    expect(onMessage).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
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

  it('does not expose actions through the public HTTP request path', async () => {
    const action = vi.fn();
    const HttpObject = createWebSocketDurableObject(
      defineRoom({ messages, actions: { revokeSession: action } }),
      route,
    );
    const env = {
      RELAY_WS: {
        idFromName: () => 'id',
        get: () => new HttpObject(state, {}),
      },
    };

    const response = await forwardWebSocketRequest(
      new Request('https://app.test/relay/acct_1', {
        method: 'POST',
        headers: { 'x-void-room-action': 'revokeSession' },
        body: JSON.stringify({ sessionId: 'session_1' }),
      }),
      env,
      route,
    );

    expect(response.status).toBe(426);
    expect(action).not.toHaveBeenCalled();
  });
});
