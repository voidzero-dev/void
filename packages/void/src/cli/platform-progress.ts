import { createSpinner } from './output.ts';

export function createPlatformProgress(message?: string): ReturnType<typeof createSpinner> {
  const progress = createSpinner({
    onCancel: () => {
      // Keep the installer's subprocess signal coordinator in charge of cancellation.
      if (!process.emit('SIGINT')) {
        process.exit(130);
      }
    },
  });
  if (message !== undefined) {
    progress.start(message);
  }
  return progress;
}

/** Clear a preflight phase before a plan, prompt, or error takes over the terminal. */
export async function withPlatformProgress<T>(
  message: string,
  action: () => Promise<T>,
): Promise<T> {
  const progress = createPlatformProgress(message);
  try {
    return await action();
  } finally {
    progress.clear();
  }
}
