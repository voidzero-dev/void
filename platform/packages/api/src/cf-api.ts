/**
 * Retry an async operation with exponential backoff.
 * `fn` returns `T` on success, or `undefined` to signal a retry.
 * Throws immediately if `fn` itself throws.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T | undefined>,
  opts: { maxRetries: number; delayMs: number; errorMessage: string },
): Promise<T> {
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, opts.delayMs * 2 ** (attempt - 1));
      });
    }
    const result = await fn(attempt);
    if (result !== undefined) {
      return result;
    }
  }
  throw new Error(opts.errorMessage);
}

export async function deleteDispatchScript(
  accountId: string,
  apiToken: string,
  namespace: string,
  scriptName: string,
): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    },
  );
  if (!res.ok && res.status !== 404) {
    console.error(`Failed to delete dispatch script ${scriptName}: ${res.status}`);
  }
}
