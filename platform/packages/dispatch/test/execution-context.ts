import { vi } from 'vite-plus/test';

export function createMockExecutionContext() {
  const context = {
    waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
    passThroughOnException: vi.fn<() => void>(),
  };
  return context as typeof context & ExecutionContext;
}

export async function waitForBackgroundTasks(
  context: ReturnType<typeof createMockExecutionContext>,
) {
  await Promise.all(context.waitUntil.mock.calls.map(([promise]) => promise));
}
