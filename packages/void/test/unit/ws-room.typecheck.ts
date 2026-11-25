import { assert, expectTypeOf } from 'vite-plus/test';
import { defineRoom } from '../../src/runtime/ws/index.ts';
import type { RoomActionContext } from '../../src/runtime/ws/index.ts';
import { getRoom } from '../../src/runtime/ws/room.ts';
import type { RoomHandle } from '../../src/runtime/ws/room.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

declare module 'void/routes' {
  interface WebSocketRouteMap {
    '/relay/[accountId]': {
      params: { accountId: string };
      client: { type: 'relay.ping' };
      server: { type: 'relay.closed'; closed: number };
      actions: {
        revokeSession: (
          context: RoomActionContext,
          sessionId: string,
          code: number,
        ) => { closed: number };
        ping: (context: RoomActionContext) => string;
      };
    };
    '/feed': {
      params: Record<string, never>;
      client: { type: 'feed.ack' };
      server: { type: 'feed.item' };
    };
  }
}

declare const client: StandardSchemaV1<{ type: 'relay.ping' }>;
declare const server: StandardSchemaV1<{ type: 'relay.closed'; closed: number }>;

const definition = defineRoom({
  messages: { client, server },
  actions: {
    revokeSession: (context, sessionId: string, code: number) => {
      expectTypeOf(context.id).toEqualTypeOf<string>();
      expectTypeOf(context.params).toEqualTypeOf<Record<string, string>>();
      expectTypeOf<typeof context.room.getConnections>().toBeFunction();
      for (const connection of context.room.getConnections()) {
        connection.close(code, 'revoked');
      }
      return { closed: 1, sessionId };
    },
    ping: (context) => context.id,
  },
});

assert(definition.actions);
expectTypeOf(definition.actions.revokeSession).toEqualTypeOf<
  (
    context: RoomActionContext,
    sessionId: string,
    code: number,
  ) => { closed: number; sessionId: string }
>();
expectTypeOf(definition.actions.ping).toEqualTypeOf<(context: RoomActionContext) => string>();

const plain = defineRoom({ messages: { client, server } });
expectTypeOf(plain.actions).toEqualTypeOf<Record<never, never> | undefined>();

const room = getRoom('/relay/[accountId]', { params: { accountId: 'acct_1' } });
expectTypeOf(room).toEqualTypeOf<RoomHandle<'/relay/[accountId]'>>();
expectTypeOf(room.actions.revokeSession).toEqualTypeOf<
  (sessionId: string, code: number) => Promise<{ closed: number }>
>();
expectTypeOf(room.actions.ping).toEqualTypeOf<() => Promise<string>>();

// @ts-expect-error Routes with parameters require them.
getRoom('/relay/[accountId]');
// @ts-expect-error Parameter names come from the route.
getRoom('/relay/[accountId]', { params: { accountId: 'acct_1', extra: 'x' } });
// @ts-expect-error Action arguments are typed.
void room.actions.revokeSession(1, 4001);
// @ts-expect-error Action arguments are required.
void room.actions.revokeSession('session_1');
// @ts-expect-error Only declared actions exist.
room.actions.missing();
// @ts-expect-error defineWebSocket() routes expose no actions.
getRoom('/feed');
