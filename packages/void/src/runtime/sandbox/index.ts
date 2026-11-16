import type { Files } from '@cloudflare/sandbox';
import { getRawRuntimeEnv } from './env-raw.ts';
import { requireRuntimeBinding } from './env.ts';
import { UsageLimit } from './limits.ts';
import {
  SandboxContainer,
  SANDBOX_PORT_HEADER,
  validateSandboxOptions,
  type SandboxCapability,
  type SandboxOptions,
  type SandboxExecOptions,
  type SandboxProcessWire,
} from './sandbox-container.ts';

export * from '@cloudflare/sandbox';
export type { SandboxOptions, SandboxExecOptions };
export const DEFAULT_SANDBOX_ID = 'default';
export const DEFAULT_SANDBOX_BINDING = 'SANDBOX';
export const SANDBOX_SERVICE_BINDING = '__VOID_SANDBOX';
export type VoidSandboxOptions = SandboxOptions & { binding?: string; normalizeId?: boolean };
export type SandboxProcess = {
  pid: number;
  isPty: boolean;
  stdin: WritableStream | null;
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
  readonly exitCode: Promise<number>;
  output(): Promise<ExecOutput>;
  kill(signal?: number): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
};
export type SandboxFiles = {
  [K in keyof Files]: Files[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R>
    : never;
};
export type SandboxClient = {
  exec(argv: Array<string>, options?: SandboxExecOptions): Promise<SandboxProcess>;
  run(argv: Array<string>, options?: SandboxExecOptions): Promise<ExecOutput>;
  files: SandboxFiles;
  fetch(port: number, request: Request): Promise<Response>;
  running(): Promise<boolean>;
  destroy(): Promise<void>;
};

export class SandboxLimitError extends UsageLimit {
  override readonly name = 'SandboxLimitError';
  declare readonly reason: 'concurrency' | 'runtime_budget';
  constructor(reason: 'concurrency' | 'runtime_budget', message?: string) {
    super({ resource: 'sandbox', reason, message: message ?? `Sandbox limit reached: ${reason}` });
  }
}
export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError';
  constructor(message = 'Managed Sandbox is unavailable on this Void platform.') {
    super(message);
  }
}
let sandboxBindingName = DEFAULT_SANDBOX_BINDING;
export function __setSandboxBindingName(bindingName: string): void {
  sandboxBindingName = bindingName;
}

function rethrowSandboxError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  for (const reason of ['concurrency', 'runtime_budget'] as const) {
    if (message.includes(`VOID_SANDBOX_${reason}`)) {
      throw new SandboxLimitError(reason);
    }
  }
  if (message.includes('VOID_SANDBOX_unavailable')) {
    throw new SandboxUnavailableError();
  }
  throw error;
}

function encodeOptions(value: unknown): { options: unknown; finish(): void } {
  if (!value || typeof value !== 'object') {
    return { options: value, finish() {} };
  }
  const { signal, ...options } = value as SandboxExecOptions;
  if (!signal) {
    return { options, finish() {} };
  }
  signal.throwIfAborted();
  let closed = false;
  let remove!: () => void;
  let finish!: () => void;
  const abort = new ReadableStream({
    start(controller) {
      const listener = () => finish();
      remove = () => signal.removeEventListener('abort', listener);
      finish = () => {
        remove();
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      signal.addEventListener('abort', listener, { once: true });
    },
    cancel() {
      closed = true;
      remove();
    },
  });
  return { options: { ...options, abort }, finish };
}

function client(
  capability: SandboxCapability,
  nativeFetch?: (request: Request) => Promise<Response>,
): SandboxClient {
  const call = async (operation: string, args: Array<unknown>): Promise<unknown> => {
    try {
      return await capability.invoke(operation, args);
    } catch (error) {
      rethrowSandboxError(error);
    }
  };
  const callWithOptions = async (
    operation: string,
    args: Array<unknown>,
    index: number,
  ): Promise<unknown> => {
    const encoded = encodeOptions(args[index]);
    args[index] = encoded.options;
    try {
      return await call(operation, args);
    } catch (error) {
      // Admission and validation can fail before the receiver reads the channel.
      encoded.finish();
      throw error;
    }
  };
  const files = new Proxy(Object.create(null) as SandboxFiles, {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') {
        return undefined;
      }
      return (...args: Array<unknown>) => {
        const index = method === 'writeFile' || method === 'rename' ? 3 : 2;
        return callWithOptions('files', [method, ...args], index);
      };
    },
  });
  const execute = async (
    argv: Array<string>,
    options?: SandboxExecOptions,
  ): Promise<SandboxProcess> => {
    const wire = (await callWithOptions('exec', [argv, options], 1)) as SandboxProcessWire;
    let exitCode: Promise<number> | undefined;
    let output: Promise<ExecOutput> | undefined;
    const process: SandboxProcess = {
      pid: wire.pid,
      isPty: wire.isPty,
      stdin: wire.stdin,
      stdout: wire.stdout,
      stderr: wire.stderr,
      get exitCode() {
        return (exitCode ??= (async (): Promise<number> => {
          try {
            return (await wire.capability.invoke('exitCode', [])) as number;
          } catch (error) {
            rethrowSandboxError(error);
          }
        })());
      },
      output() {
        return (output ??= (async (): Promise<ExecOutput> => {
          try {
            return await Promise.all([
              wire.stdout ? new Response(wire.stdout).arrayBuffer() : new ArrayBuffer(0),
              wire.stderr ? new Response(wire.stderr).arrayBuffer() : new ArrayBuffer(0),
              process.exitCode,
            ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
          } catch (error) {
            rethrowSandboxError(error);
          }
        })());
      },
      kill: async (signal) => {
        await wire.capability.invoke('kill', [signal]);
      },
      resize: async (cols, rows) => {
        await wire.capability.invoke('resize', [cols, rows]);
      },
    };
    return process;
  };
  return {
    files,
    exec: execute,
    run: async (argv, options) => {
      const process = await execute(argv, options);
      return process.output();
    },
    fetch: async (port, request) => {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return (await call('fetch', [port, request])) as Response;
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new TypeError('Invalid Sandbox TCP port.');
      }
      if (!nativeFetch) {
        throw new SandboxUnavailableError(
          'Sandbox WebSockets require a native Cloudflare deployment.',
        );
      }
      const headers = new Headers(request.headers);
      headers.set(SANDBOX_PORT_HEADER, String(port));
      return nativeFetch(new Request(request, { headers }));
    },
    running: async () => (await call('running', [])) as boolean,
    destroy: async () => {
      await call('destroy', []);
    },
  };
}

/** Generated local/native DO. Managed execution uses the trusted controller. */
export class VoidPlatformSandbox<Env = unknown> extends SandboxContainer<Env> {
  protected override async beforeStart(): Promise<void> {
    const env = this.env as Record<string, unknown>;
    if (env.__PROJECT_ID !== undefined || env.__VOID_PROXY !== undefined) {
      throw new SandboxUnavailableError(
        'Managed Sandboxes require the platform Sandbox controller. Redeploy this application.',
      );
    }
  }
}

/** Resolve a container by name. Starts on the first command, file or port operation. */
export async function getSandbox(
  id: string = DEFAULT_SANDBOX_ID,
  options: VoidSandboxOptions = {},
): Promise<SandboxClient> {
  const { binding = sandboxBindingName, normalizeId = true, ...sandboxOptions } = options;
  if (typeof normalizeId !== 'boolean') {
    throw new TypeError('Sandbox normalizeId must be a boolean.');
  }
  validateSandboxOptions(sandboxOptions);
  if (typeof id !== 'string' || id.length === 0 || id.length > 63) {
    throw new TypeError('Sandbox id must contain between 1 and 63 characters.');
  }
  if (normalizeId) {
    id = id.toLowerCase();
  }
  const env = getRawRuntimeEnv();
  const service = env[SANDBOX_SERVICE_BINDING] as
    | { getSandbox(id: string, options: SandboxOptions): Promise<SandboxCapability> }
    | undefined;
  if (service) {
    if (binding !== sandboxBindingName) {
      throw new SandboxUnavailableError(`Managed Sandbox binding ${binding} is unavailable.`);
    }
    try {
      return client(await service.getSandbox(id, sandboxOptions));
    } catch (error) {
      rethrowSandboxError(error);
    }
  }
  if (env.__PROJECT_ID !== undefined || env.__VOID_PROXY !== undefined) {
    throw new SandboxUnavailableError(
      'This deployment has no managed Sandbox controller. Redeploy this application.',
    );
  }
  const stub =
    requireRuntimeBinding<DurableObjectNamespace<VoidPlatformSandbox>>(binding).getByName(id);
  await stub.configure(sandboxOptions);
  return client(stub, (request) => stub.fetch(request));
}
export const sandbox: { get: typeof getSandbox } = { get: getSandbox };
