import type { CloudflareOperation, CloudflareProviderError } from './operations.ts';
export type CloudflareCommandResult = {
  /** Structured provider response. stdout is diagnostics only. */
  data?: unknown;
  errorCode?: number;
  failure?: 'not-found' | 'durable-migration' | 'containers-unavailable';
  errors?: Array<CloudflareProviderError>;
  stdout: string;
  stderr: string;
  status: number;
  signal?: NodeJS.Signals | null;
  error?: string | null;
};

export type CloudflareCommandRunner = (
  operation: CloudflareOperation,
  options: { capture: boolean },
) => CloudflareCommandResult | Promise<CloudflareCommandResult>;

export type CloudflareDeployExecution =
  | { ok: true }
  | { ok: false; reason: 'uploader-changed' }
  | { ok: false; reason: 'deploy-failed'; status: number };

/** Upload the already-verified Worker artifact without Wrangler autoconfiguration. */
export async function executeCloudflareDeploy(options: {
  runWrangler: CloudflareCommandRunner;
  verifyUploader: () => boolean;
  configPath?: string;
}): Promise<CloudflareDeployExecution> {
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }

  const result = await options.runWrangler(
    { type: 'worker.deploy', ...(options.configPath ? { configPath: options.configPath } : {}) },
    { capture: false },
  );
  if (!isCleanCommandExit(result)) {
    return { ok: false, reason: 'deploy-failed', status: result.status };
  }
  return { ok: true };
}

/** The command ran to completion, whatever its exit status. */
export function isCompletedCommand(result: CloudflareCommandResult): boolean {
  return (
    Number.isSafeInteger(result.status) &&
    result.status >= 0 &&
    result.signal == null &&
    (result.error == null || result.error === '')
  );
}

export function isCleanCommandExit(result: CloudflareCommandResult): boolean {
  return result.status === 0 && isCompletedCommand(result);
}

/** Cloudflare reported that the Worker or its deployment does not exist (code 10007). */
export function isWorkerNotFound(result: CloudflareCommandResult): boolean {
  return (
    isCompletedCommand(result) && (result.failure === 'not-found' || result.errorCode === 10_007)
  );
}
