import { literal, object, pipe, regex, string } from 'valibot';
import { defineWebSocket } from 'void/ws';

const marker = pipe(string(), regex(/^void-e2e-[a-f0-9]{16}$/));

export default defineWebSocket({
  messages: {
    client: object({ marker }),
    server: object({ kind: literal('echo'), marker }),
  },
  onBeforeConnect(ctx) {
    const secret = ctx.env.SECRET_KEY;
    if (
      typeof secret !== 'string' ||
      !secret ||
      ctx.request.headers.get('x-void-e2e-token') !== secret
    ) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  },
  async onMessage(ctx, event) {
    await ctx.socket.send({ kind: 'echo', marker: event.marker });
  },
});
