import { queueResults } from '@schema';
import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { db, eq, desc } from 'void/db';
import { queues } from 'void/queues';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const results = await db.select().from(queueResults).orderBy(desc(queueResults.id)).limit(50);
  return { results };
});

export const action = defineHandler(async (c) => {
  const body = await c.req.json<{ intent?: string; key: string; value?: string; id?: number }>();

  if (body.intent === 'delete') {
    await db.delete(queueResults).where(eq(queueResults.id, body.id!));
  } else {
    await queues['demo-queue'].send({ key: body.key, value: body.value! });
  }
});
