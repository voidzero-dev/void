import { defineHandler } from 'void';
import { sendEmail } from 'void/email';
import type { SendEmailOptions } from 'void/email';
import { env } from 'void/env';
import { kv } from 'void/kv';

export const POST = defineHandler(async (c) => {
  const secret = env.SECRET_KEY;
  if (typeof secret !== 'string' || !secret || c.req.header('x-void-e2e-token') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<SendEmailOptions>();
  return c.json(await sendEmail(body));
});

export const GET = defineHandler(async (c) => {
  const secret = env.SECRET_KEY;
  if (typeof secret !== 'string' || !secret || c.req.header('x-void-e2e-token') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const subject = c.req.query('subject');
  if (!subject || subject.length > 180) {
    return c.json({ error: 'subject must contain 1–180 characters' }, 400);
  }
  return c.json(await kv.get(`email-e2e:${subject}`));
});
