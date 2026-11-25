import { vi } from 'vite-plus/test';
import type { Mock, MockInstance } from 'vite-plus/test';
import type { GithubConnection, ProjectResponse } from '../../src/cli/client.ts';

export const projectId = 'proj_test';
export const slug = 'my-app';

const realFetch = globalThis.fetch.bind(globalThis);

export function makeProject(): ProjectResponse {
  return {
    id: projectId,
    user_id: 'user_1',
    slug,
    type: 'void',
    created_at: '2024-01-01T00:00:00Z',
    custom_domain: null,
    role: 'owner',
  };
}

export function makeConnection(overrides: Partial<GithubConnection> = {}): GithubConnection {
  return {
    id: 'conn_1',
    project_id: projectId,
    installation_id: '123456',
    repo_full_name: 'octocat/hello-world',
    branch: 'main',
    build_executor: 'container',
    workflow_path: '.github/workflows/void-deploy.yml',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Makes `process.exit` throw so a test can assert the exit without stopping the runner. */
export function throwOnProcessExit(): MockInstance<typeof process.exit> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
}

export interface BrowserCallback {
  authUrl: Mock<(redirect: string) => Promise<{ url: string }>>;
  /** Settles with the command, after the simulated redirect has finished. */
  settle: <T>(run: Promise<T>) => Promise<T>;
}

/**
 * Fakes the platform endpoint that returns a GitHub authorize URL. When the
 * command requests it, `query` turns the command's localhost callback URL into
 * the redirect a browser would send back.
 */
export function browserCallback(query?: (callbackUrl: URL) => URL): BrowserCallback {
  let resolveCallback!: (url: URL) => void;
  const callbackReady = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });
  const authUrl = vi.fn(async (redirect: string) => {
    resolveCallback(new URL(redirect));
    return { url: 'https://github.com/login/oauth/authorize?client_id=x' };
  });
  // Error paths close the callback server mid-response, so the redirect may reject.
  const fired = query
    ? callbackReady.then(async (callbackUrl) => {
        await realFetch(query(callbackUrl)).catch(() => {});
      })
    : Promise.resolve();
  return {
    authUrl,
    settle: (run) => run.finally(() => fired.catch(() => {})),
  };
}
