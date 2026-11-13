import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vite-plus/test';
import { requireAuth, type AuthUser } from '../../src/runtime/auth.ts';

const user: AuthUser = {
  id: 'demo',
  name: 'Demo user',
  email: 'demo@example.com',
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function appFor(currentUser: AuthUser | null, options?: { throwRedirect?: string }) {
  const app = new Hono<{ Variables: { user: AuthUser | null } }>();
  const authorized = vi.fn();
  app.use(async (c, next) => {
    c.set('user', currentUser);
    await next();
  });
  app.all('/account', (c) => {
    const result = requireAuth(c, options);
    expect(result).toBe(currentUser);
    authorized();
    return c.json({ email: result.email });
  });
  return { app, authorized };
}

describe('requireAuth', () => {
  it.each([undefined, {}, { throwRedirect: undefined }])(
    'keeps the plain-text 401 default with options %j',
    async (options) => {
      const { app, authorized } = appFor(null, options);
      const response = await app.request('/account');
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('text/plain');
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).toBe('Unauthorized');
      expect(authorized).not.toHaveBeenCalled();
    },
  );

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'redirects unauthenticated %s requests without running protected work',
    async (method) => {
      const { app, authorized } = appFor(null, { throwRedirect: '/login?reason=expired' });
      const response = await app.request('/account?tab=settings', { method });
      expect(response.status).toBe(method === 'GET' || method === 'HEAD' ? 302 : 303);
      expect(response.headers.get('location')).toBe('/login?reason=expired');
      expect(authorized).not.toHaveBeenCalled();
    },
  );

  it('uses the supplied login destination without adding return parameters', async () => {
    const { app } = appFor(null, { throwRedirect: '/login' });
    const response = await app.request('/account?tab=settings');
    expect(response.headers.get('location')).toBe('/login');
  });

  it('throws an HTTPException carrying the redirect response from a nested helper', async () => {
    const { app } = appFor(null);
    app.get('/nested', (c) => {
      const guard = () => requireAuth(c, { throwRedirect: '/login' });
      expect(guard).toThrow(HTTPException);
      try {
        guard();
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPException);
        const exception = error as HTTPException;
        expect(exception.status).toBe(302);
        expect(exception.getResponse().headers.get('location')).toBe('/login');
        throw error;
      }
      return c.text('protected');
    });
    expect((await app.request('/nested')).status).toBe(302);
  });

  it.each([undefined, { throwRedirect: '/login' }])(
    'returns the authenticated user with options %j',
    async (options) => {
      const { app, authorized } = appFor(user, options);
      const response = await app.request('/account');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ email: user.email });
      expect(authorized).toHaveBeenCalledOnce();
    },
  );
});
