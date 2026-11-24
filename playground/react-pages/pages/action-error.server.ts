import * as v from 'valibot';
import { defineHandler } from 'void';

let successfulSubmissions = 0;
let lastMessage = 'No successful submission yet.';

export type Props = Readonly<{
  successfulSubmissions: number;
  lastMessage: string;
}>;

const messageSchema = v.object({
  message: v.pipe(v.string(), v.minLength(1, 'Message is required')),
});

const profileSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1, 'Name is required')),
  email: v.pipe(v.string(), v.email('Email must be valid')),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function json(body: unknown, status: number, statusText: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

export const loader = defineHandler<Props>(() => ({
  successfulSubmissions,
  lastMessage,
}));

export const actions = {
  default: defineHandler(() => {
    return new Response('Conflict', { status: 409, statusText: 'Conflict' });
  }),

  success: defineHandler.withValidator({
    body: messageSchema,
  })(async (_c, { body }) => {
    successfulSubmissions += 1;
    lastMessage = body.message.trim();
  }),

  validation: defineHandler.withValidator({
    body: profileSchema,
  })(async () => {
    successfulSubmissions += 1;
    lastMessage = 'Validation form submitted successfully.';
  }),

  missing: defineHandler(() => {
    return json({ reason: 'This record no longer exists.' }, 404, 'Not Found');
  }),

  rateLimit: defineHandler(() => {
    return json({ retryAfter: 30 }, 429, 'Too Many Requests');
  }),

  unauthorized: defineHandler(() => {
    return new Response('Sign in required', { status: 401, statusText: 'Unauthorized' });
  }),

  forbidden: defineHandler(() => {
    return new Response('Not allowed', { status: 403, statusText: 'Forbidden' });
  }),

  server: defineHandler(() => {
    return new Response('Server exploded', { status: 500, statusText: 'Internal Server Error' });
  }),

  slow: defineHandler.withValidator({
    body: messageSchema,
  })(async (_c, { body }) => {
    await sleep(1500);
    successfulSubmissions += 1;
    lastMessage = `Slow action finished: ${body.message.trim()}`;
  }),
};
