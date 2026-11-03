import { spawnSync } from 'node:child_process';
import type { CloudflareCommandResult, CloudflareOperation } from '@void/deploy-cloudflare';
import { CF_VERSION_SOURCE_MAX_OUTPUT_BYTES } from './cf-command-values.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';

/** Operations contain public targets only. Secret values travel through stdin. */
export function encodeCloudflareOperation(operation: CloudflareOperation): Array<string> {
  return [JSON.stringify(operation)];
}

type ProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  error?: string | null;
};

type OperationEnvelopeFields = {
  data?: unknown;
  errorCode?: number;
  errors?: Array<{ code?: number; message: string }>;
  failure?: CloudflareCommandResult['failure'];
  signal?: NodeJS.Signals | null;
  error?: string | null;
};

/** True only for a child that ran to completion with a clean exit 0. */
export function isCleanCloudflareExit(
  result: Pick<ProcessResult, 'status' | 'signal' | 'error'>,
): boolean {
  return (
    result.status === 0 && result.signal == null && (result.error == null || result.error === '')
  );
}

/** Decode the private process envelope once, retaining cancellation provenance. */
export function decodeCloudflareOperationResult<T extends ProcessResult>(
  result: T,
): T & OperationEnvelopeFields {
  if (result.signal || result.error || result.status === null) {
    return result;
  }
  if (!result.stdout.trim() && result.status !== 0) {
    return result;
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('operationResult' in value) ||
      value.operationResult !== 1
    ) {
      throw new Error('Invalid operation envelope.');
    }
    const envelope = value as OperationEnvelopeFields & { output?: string };
    if (
      (envelope.output !== undefined && typeof envelope.output !== 'string') ||
      (envelope.signal != null && typeof envelope.signal !== 'string') ||
      (envelope.error != null && typeof envelope.error !== 'string') ||
      (envelope.errorCode !== undefined && !Number.isSafeInteger(envelope.errorCode)) ||
      (envelope.failure !== undefined &&
        !['not-found', 'durable-migration', 'containers-unavailable'].includes(envelope.failure)) ||
      (envelope.errors !== undefined &&
        (!Array.isArray(envelope.errors) ||
          envelope.errors.some(
            (error) =>
              !error ||
              typeof error !== 'object' ||
              typeof error.message !== 'string' ||
              (error.code !== undefined && !Number.isSafeInteger(error.code)),
          )))
    ) {
      throw new Error('Invalid operation envelope fields.');
    }
    if (envelope.signal || envelope.error) {
      return { ...result, status: 1, stdout: '', signal: envelope.signal, error: envelope.error };
    }
    return {
      ...result,
      stdout: envelope.output ?? '',
      data: envelope.data,
      errorCode: envelope.errorCode,
      errors: envelope.errors,
      failure: envelope.failure,
    };
  } catch {
    return {
      ...result,
      status: 1,
      stdout: '',
      stderr: [result.stderr, 'Cloudflare tooling returned an invalid operation response.']
        .filter(Boolean)
        .join('\n'),
    };
  }
}

/** Echo a decoded result to the terminal when the caller did not capture it. */
function writeUncapturedOperationOutput(result: { stdout: string; stderr: string }): void {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

export function createCloudflareProcessRunner(options: {
  root: string;
  accountId?: string;
  apiBaseUrl?: string;
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  timeoutMs?: number;
}) {
  const [command, ...prefix] = resolveCloudflareOperationArgv();
  return (
    operation: CloudflareOperation,
    run: { capture: boolean; input?: string; cwd?: string },
  ): CloudflareCommandResult => {
    const streaming =
      !run.capture && (operation.type === 'auth.login' || operation.type === 'tail');
    const env = typeof options.env === 'function' ? options.env() : (options.env ?? process.env);
    const result = spawnSync(command, [...prefix, ...encodeCloudflareOperation(operation)], {
      cwd: run.cwd ?? options.root,
      env: {
        ...env,
        ...(options.accountId ? { CLOUDFLARE_ACCOUNT_ID: options.accountId } : {}),
        ...(options.apiBaseUrl ? { CLOUDFLARE_API_BASE_URL: options.apiBaseUrl } : {}),
      },
      input: run.input,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer:
        operation.type === 'versions.view' && operation.includeSource
          ? CF_VERSION_SOURCE_MAX_OUTPUT_BYTES
          : 32 * 1024 * 1024,
      timeout: options.timeoutMs,
      stdio: streaming ? ['inherit', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    });
    const raw = {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      signal: result.signal,
      error: result.error?.message,
    };
    if (streaming) {
      return raw;
    }
    const decoded = decodeCloudflareOperationResult(raw);
    if (!run.capture) {
      writeUncapturedOperationOutput(decoded);
    }
    return decoded;
  };
}
