import { HTTPException } from 'hono/http-exception';
import { defineHandler, type CloudContext, type InferProps } from 'void';
import { getUser, requireAuth } from 'void/auth';
import { requirePageUser } from '../../src/require-page-user.ts';

function mode(c: CloudContext) {
  const value = c.req.param('mode');
  if (value === 'require-auth' || value === 'return-redirect' || value === 'throw-redirect') {
    return value;
  }
  throw new HTTPException(404);
}

export type Props = InferProps<typeof loader>;

// The form is public; the action checks auth again on every submission.
export const loader = defineHandler((c) => ({ mode: mode(c), email: getUser()?.email ?? null }));

export const action = defineHandler((c) => {
  const variant = mode(c);
  if (variant === 'require-auth') {
    requireAuth(c);
  }
  if (variant === 'return-redirect' && !getUser()) {
    return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`, 303);
  }
  if (variant === 'throw-redirect') {
    requirePageUser(c, 303);
  }

  // A real mutation would run here, only after the auth check succeeds.
  return c.redirect('/actions/success', 303);
});
