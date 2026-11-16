import { describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  client: vi.fn((options?: unknown) => ({ framework: 'client', options })),
  react: vi.fn((options?: unknown) => ({ framework: 'react', options })),
  solid: vi.fn((options?: unknown) => ({ framework: 'solid', options })),
  svelte: vi.fn((options?: unknown) => ({ framework: 'svelte', options })),
  vue: vi.fn((options?: unknown) => ({ framework: 'vue', options })),
}));

vi.mock('better-auth/client', () => ({
  createAuthClient: mocks.client,
}));

vi.mock('better-auth/react', () => ({
  createAuthClient: mocks.react,
}));

vi.mock('better-auth/vue', () => ({
  createAuthClient: mocks.vue,
}));

vi.mock('better-auth/svelte', () => ({
  createAuthClient: mocks.svelte,
}));

vi.mock('better-auth/solid', () => ({
  createAuthClient: mocks.solid,
}));

describe('client runtimes', () => {
  it.each([
    ['default', 'client', () => import('../../src/runtime/client/index.ts')],
    ['React', 'react', () => import('../../src/runtime/client/react.ts')],
    ['Vue', 'vue', () => import('../../src/runtime/client/vue.ts')],
    ['Svelte', 'svelte', () => import('../../src/runtime/client/svelte.ts')],
    ['Solid', 'solid', () => import('../../src/runtime/client/solid.ts')],
  ] as const)('re-exports the %s Better Auth client', async (_name, framework, load) => {
    const { auth, createAuthClient } = await load();
    expect(createAuthClient).toBe(mocks[framework]);
    expect(mocks[framework]).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(auth).toEqual({ framework, options: { basePath: '/api/auth' } });
  });
});
