import { describe, expect, it, vi } from 'vite-plus/test';
import {
  authContext,
  getSession,
  getUser,
  type AuthState,
  type AuthUser,
} from '../../src/runtime/auth/index.ts';

describe('authContext', () => {
  it('runs callback with provided store and exposes it via getUser/getSession', () => {
    const user = {
      id: 'u1',
      email: 'a@b.c',
      emailVerified: false,
      name: 'A',
      image: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } satisfies AuthUser;
    const state = {
      user,
      session: {
        id: 's1',
        token: 't1',
        userId: user.id,
        expiresAt: new Date(0),
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    } satisfies AuthState;

    expect(getUser()).toBeNull();
    expect(getSession()).toBeNull();

    authContext.run({ user, state }, () => {
      expect(getUser()).toBe(user);
      expect(getSession()).toBe(state);
    });
    authContext.run({ user: null, state: null }, () => {
      expect(getUser()).toBeNull();
    });

    expect(getUser()).toBeNull();
    expect(getSession()).toBeNull();
  });

  it('returns the same ALS instance across module re-evaluations', async () => {
    // resetModules re-evaluates auth.ts, like a second module load.
    vi.resetModules();
    const first = await import('../../src/runtime/auth/index.ts');
    vi.resetModules();
    const second = await import('../../src/runtime/auth/index.ts');

    expect(first.authContext).toBe(second.authContext);
    expect(authContext).toBe(first.authContext);
  });
});
