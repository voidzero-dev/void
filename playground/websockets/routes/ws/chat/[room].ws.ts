import {
  literal,
  maxLength,
  minLength,
  number,
  object,
  pipe,
  string,
  trim,
  variant,
} from 'valibot';
import { defineRoom } from 'void/ws';

const ChatClientMessage = variant('type', [
  object({
    type: literal('chat.join'),
    name: pipe(string(), trim(), minLength(1), maxLength(24)),
  }),
  object({
    type: literal('chat.message'),
    text: pipe(string(), trim(), minLength(1), maxLength(280)),
  }),
]);

const ChatServerMessage = variant('type', [
  object({
    type: literal('chat.system'),
    id: string(),
    text: string(),
    activeConnections: number(),
  }),
  object({
    type: literal('chat.message'),
    id: string(),
    name: string(),
    text: string(),
    sentAt: string(),
  }),
]);

type ChatConnectionState = {
  name?: string;
};

function activeConnectionCount(
  room: Parameters<NonNullable<typeof definition.onConnect>>[0]['room'],
): number {
  return Array.from(room.getConnections()).length;
}

const definition = defineRoom({
  messages: {
    client: ChatClientMessage,
    server: ChatServerMessage,
  },
  async onConnect(ctx) {
    await ctx.connection.send({
      type: 'chat.system',
      id: crypto.randomUUID(),
      text: `Connected to room "${ctx.params.room}"`,
      activeConnections: activeConnectionCount(ctx.room),
    });
  },
  async onMessage(ctx, event) {
    if (event.type === 'chat.join') {
      ctx.connection.setState({ name: event.name } satisfies ChatConnectionState);
      await ctx.room.broadcast({
        type: 'chat.system',
        id: crypto.randomUUID(),
        text: `${event.name} joined ${ctx.params.room}`,
        activeConnections: activeConnectionCount(ctx.room),
      });
      return;
    }

    const state = (ctx.connection.state as ChatConnectionState | undefined) ?? {};
    if (!state.name) {
      await ctx.connection.send({
        type: 'chat.system',
        id: crypto.randomUUID(),
        text: 'Join the room before sending messages',
        activeConnections: activeConnectionCount(ctx.room),
      });
      return;
    }

    await ctx.room.broadcast({
      type: 'chat.message',
      id: crypto.randomUUID(),
      name: state.name,
      text: event.text,
      sentAt: new Date().toISOString(),
    });
  },
  async onClose(ctx) {
    const state = (ctx.connection.state as ChatConnectionState | undefined) ?? {};
    if (!state.name) {
      return;
    }

    const remaining = Math.max(0, activeConnectionCount(ctx.room) - 1);
    await ctx.room.broadcast({
      type: 'chat.system',
      id: crypto.randomUUID(),
      text: `${state.name} left ${ctx.params.room}`,
      activeConnections: remaining,
    });
  },
  onRequest(ctx) {
    return Response.json({
      ok: true,
      room: ctx.params.room,
      kind: 'room',
    });
  },
});

export default definition;
