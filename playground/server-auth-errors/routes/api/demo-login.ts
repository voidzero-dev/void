import { defineHandler } from 'void';
import { getAuth } from 'void/auth';
import { demoUser } from '../../src/demo-user.ts';

// This demo always signs in the same user, regardless of the submitted fields.
export const POST = defineHandler(async (c) => {
  const auth = getAuth(c);
  const options = { body: demoUser, headers: c.req.raw.headers, asResponse: true } as const;
  const response = await auth.api.signInEmail(options);
  if (response.status !== 401) {
    return response;
  }

  // Initialize the demo account on the first login to a fresh database.
  const created = await auth.api.signUpEmail(options);
  if (created.status === 422) {
    // Another first login may have created the account concurrently.
    return auth.api.signInEmail(options);
  }
  return created;
});
