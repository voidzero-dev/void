import * as v from 'valibot';
import { defineWebSocket } from 'void/ws';
import type { WebSocketConnection } from 'void/ws';

const NotificationClientMessage = v.variant('type', [
  v.object({
    type: v.literal('notifications.start'),
    count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
  }),
  v.object({
    type: v.literal('notifications.stop'),
  }),
  v.object({
    type: v.literal('notifications.ack'),
    id: v.string(),
  }),
]);

const NotificationServerMessage = v.variant('type', [
  v.object({
    type: v.literal('notifications.status'),
    streaming: v.boolean(),
    pending: v.number(),
  }),
  v.object({
    type: v.literal('notifications.item'),
    id: v.string(),
    title: v.string(),
    body: v.string(),
    sentAt: v.string(),
    index: v.number(),
    total: v.number(),
  }),
  v.object({
    type: v.literal('notifications.acked'),
    id: v.string(),
  }),
  v.object({
    type: v.literal('notifications.done'),
    sent: v.number(),
  }),
]);

type NotificationServerEvent =
  | {
      type: 'notifications.status';
      streaming: boolean;
      pending: number;
    }
  | {
      type: 'notifications.item';
      id: string;
      title: string;
      body: string;
      sentAt: string;
      index: number;
      total: number;
    }
  | { type: 'notifications.acked'; id: string }
  | { type: 'notifications.done'; sent: number };

type NotificationState = {
  streamId?: string;
  pending: number;
};

declare global {
  interface ImportMeta {
    readonly env: { readonly VITE_VOID_NOTIFICATION_STREAM_DELAY_MS?: string };
  }
}

const configuredStreamDelay = Number(
  import.meta.env.VITE_VOID_NOTIFICATION_STREAM_DELAY_MS ?? '1000',
);
const STREAM_DELAY_MS = Number.isFinite(configuredStreamDelay) ? configuredStreamDelay : 1000;

function readState(socket: WebSocketConnection<NotificationServerEvent>): NotificationState {
  const state = socket.state as Partial<NotificationState> | undefined;
  return {
    streamId: state?.streamId,
    pending: state?.pending ?? 0,
  };
}

async function sendStatus(
  socket: WebSocketConnection<NotificationServerEvent>,
  state: NotificationState,
) {
  await socket.send({
    type: 'notifications.status',
    streaming: Boolean(state.streamId),
    pending: state.pending,
  });
}

function scheduleNext(
  socket: WebSocketConnection<NotificationServerEvent>,
  streamId: string,
  index: number,
  total: number,
) {
  setTimeout(() => {
    void pushNext(socket, streamId, index, total);
  }, STREAM_DELAY_MS);
}

async function pushNext(
  socket: WebSocketConnection<NotificationServerEvent>,
  streamId: string,
  index: number,
  total: number,
) {
  const state = readState(socket);
  if (state.streamId !== streamId) {
    return;
  }

  await socket.send({
    type: 'notifications.item',
    id: crypto.randomUUID(),
    title: `Notification ${index}`,
    body: `This item was streamed over a single websocket connection.`,
    sentAt: new Date().toISOString(),
    index,
    total,
  });

  const remaining = total - index;
  if (remaining > 0) {
    const nextState = { streamId, pending: remaining };
    socket.setState(nextState);
    await sendStatus(socket, nextState);
    scheduleNext(socket, streamId, index + 1, total);
    return;
  }

  const doneState = { pending: 0 } satisfies NotificationState;
  socket.setState(doneState);
  await socket.send({ type: 'notifications.done', sent: total });
  await sendStatus(socket, doneState);
}

export default defineWebSocket({
  messages: {
    client: NotificationClientMessage,
    server: NotificationServerMessage,
  },
  async onConnect(ctx) {
    const state = readState(ctx.socket);
    await sendStatus(ctx.socket, state);
  },
  async onMessage(ctx, event) {
    if (event.type === 'notifications.start') {
      const streamId = crypto.randomUUID();
      const nextState = { streamId, pending: event.count };
      ctx.socket.setState(nextState);
      await sendStatus(ctx.socket, nextState);
      scheduleNext(ctx.socket, streamId, 1, event.count);
      return;
    }

    if (event.type === 'notifications.stop') {
      const nextState = { pending: 0 } satisfies NotificationState;
      ctx.socket.setState(nextState);
      await sendStatus(ctx.socket, nextState);
      return;
    }

    await ctx.socket.send({
      type: 'notifications.acked',
      id: event.id,
    });
  },
  async onClose(ctx) {
    ctx.socket.setState({ pending: 0 } satisfies NotificationState);
  },
  onRequest() {
    return Response.json({
      ok: true,
      kind: 'socket',
    });
  },
});
