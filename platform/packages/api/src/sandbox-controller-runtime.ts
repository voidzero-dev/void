import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import { SandboxContainer, validateSandboxOptions } from 'void/_sandbox-container';
import type { SandboxOptions, SandboxInstance } from 'void/_sandbox-container';
import { getSandboxShim } from './sandbox-shim.ts';

type Admission = { ok: true } | { ok: false; reason: string };
type Control = {
  reserve(instanceId: string, generation: string): Promise<Admission>;
  started(instanceId: string, generation: string): Promise<Admission>;
  heartbeat(instanceId: string, generation: string): Promise<Admission>;
  stopped(instanceId: string, generation: string): Promise<void>;
};
type ControllerEnv = {
  SANDBOX: DurableObjectNamespace<SandboxController>;
  __VOID_SANDBOX_CONTROL: Control;
  __VOID_SANDBOX_IMAGE?: string;
  __VOID_SANDBOX_INSTANCE?: SandboxInstance;
};
type Lease = { generation: string; phase: 'pending' | 'running' | 'stopped' };
const LEASE_KEY = '__voidSandboxLease';
const ACTIVITY_KEY = '__voidSandboxActivity';
type Activity = { lastActivity: number; idleDeadline: number };
const HEARTBEAT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 5000;

function denied(reason: string): Error {
  return new Error(
    `VOID_SANDBOX_${reason === 'concurrency' || reason === 'runtime_budget' ? reason : 'unavailable'}`,
  );
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(denied('unavailable')), CONTROL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

class SandboxCapability extends RpcTarget {
  #sandbox: DurableObjectStub<SandboxController>;
  constructor(sandbox: DurableObjectStub<SandboxController>) {
    super();
    this.#sandbox = sandbox;
  }
  // oxlint-disable-next-line quality/no-unknown-returns -- This RPC forwards the operation-specific result to the SDK for decoding.
  async invoke(operation: string, args: Array<unknown>): Promise<unknown> {
    // No raw stub, control binding, configuration, alarm or startup authority.
    if (!['exec', 'files', 'fetch', 'running', 'destroy'].includes(operation)) {
      throw new TypeError(`Unsupported Sandbox operation: ${operation}`);
    }
    return this.#sandbox.invoke(operation, args);
  }
}

export default class SandboxService extends WorkerEntrypoint<ControllerEnv> {
  async getSandbox(id: string, options: SandboxOptions = {}): Promise<SandboxCapability> {
    if (typeof id !== 'string' || id.length === 0 || id.length > 63) {
      throw new TypeError('Sandbox id must contain between 1 and 63 characters.');
    }
    validateSandboxOptions(options);
    const stub = this.env.SANDBOX.getByName(id);
    await stub.configure(options);
    return new SandboxCapability(stub);
  }
  fetch(): Response {
    return new Response('Not found', { status: 404 });
  }
}

type LaunchFailure = { failure?: Error };

/** Platform-owned lifecycle; no application code is loaded in this Worker. */
export class SandboxController extends SandboxContainer<ControllerEnv> {
  #finishing: Promise<void> | undefined;
  #activity: Activity | undefined;
  #activityReady: Promise<void> | undefined;
  #busy = 0;
  #generation: LaunchFailure = {};
  protected override processContext(exitCode: Promise<number>): LaunchFailure {
    const generation = this.#generation;
    const completion: LaunchFailure = {};
    const capture = () => {
      completion.failure = generation.failure;
    };
    void exitCode.then(capture, capture);
    return completion;
  }

  async #loadActivity(): Promise<void> {
    this.#activityReady ??= (async () => {
      this.#activity = await this.ctx.storage.get<Activity>(ACTIVITY_KEY);
    })();
    await this.#activityReady;
  }
  async #touch(): Promise<void> {
    await this.#loadActivity();
    const lastActivity = Date.now();
    this.#activity = { lastActivity, idleDeadline: lastActivity + this.inactivityTimeoutMs };
    await this.ctx.storage.put(ACTIVITY_KEY, this.#activity);
  }
  async #active(): Promise<() => Promise<void>> {
    this.#busy++;
    try {
      await this.#touch();
    } catch (error) {
      this.#busy--;
      throw error;
    }
    let finished = false;
    return async () => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        if (this.container.running) {
          await this.#touch();
        }
      } finally {
        this.#busy--;
      }
    };
  }
  override async configure(options: SandboxOptions): Promise<void> {
    await super.configure(options);
    await this.#loadActivity();
    if (this.#activity) {
      this.#activity = {
        ...this.#activity,
        idleDeadline: this.#activity.lastActivity + this.inactivityTimeoutMs,
      };
      await this.ctx.storage.put(ACTIVITY_KEY, this.#activity);
    }
  }
  protected override async waitForProcessExit(
    exitCode: Promise<number>,
    context?: unknown,
  ): Promise<number> {
    const finish = await this.#active();
    try {
      try {
        const code = await exitCode;
        if ((context as { failure?: Error })?.failure) {
          throw (context as { failure: Error }).failure;
        }
        return code;
      } catch (error) {
        throw (context as { failure?: Error })?.failure ?? error;
      }
    } finally {
      await finish();
    }
  }
  #readable(stream: ReadableStream, finish?: () => Promise<void>): ReadableStream {
    const reader = stream.getReader();
    return new ReadableStream(
      {
        pull: async (controller) => {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              await finish?.();
            } else {
              // Workers RPC eagerly pumps transferred streams, even if the
              // application never reads them. A pending transport read must
              // not keep an unattended background process alive forever.
              if (!finish) {
                await this.#touch();
              }
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            controller.error(error);
            await finish?.();
          }
        },
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } finally {
            if (finish) {
              await finish();
            }
          }
        },
      },
      { highWaterMark: 0 },
    );
  }
  #writable(stream: WritableStream): WritableStream {
    const writer = stream.getWriter();
    const run = async (operation: () => Promise<void>) => {
      const finish = await this.#active();
      try {
        await operation();
      } finally {
        await finish();
      }
    };
    return new WritableStream({
      write: (chunk) => run(() => writer.write(chunk)),
      close: () => run(() => writer.close()),
      abort: (reason) => run(() => writer.abort(reason)),
    });
  }
  // oxlint-disable-next-line quality/no-unknown-returns -- Preserve the inherited RPC result contract while wrapping streams.
  override async invoke(operation: string, args: Array<unknown>): Promise<unknown> {
    if (!['exec', 'files', 'fetch'].includes(operation)) {
      return super.invoke(operation, args);
    }
    const finish = await this.#active();
    let streaming = false;
    try {
      const result = await super.invoke(operation, args);
      if (result instanceof Response && result.body) {
        streaming = true;
        return new Response(this.#readable(result.body, finish), result);
      }
      if (operation === 'exec') {
        const process = result as {
          stdout: ReadableStream | null;
          stderr: ReadableStream | null;
          stdin: WritableStream | null;
        };
        if (process.stdout) {
          process.stdout = this.#readable(process.stdout);
        }
        if (process.stderr) {
          process.stderr = this.#readable(process.stderr);
        }
        if (process.stdin) {
          process.stdin = this.#writable(process.stdin);
        }
      }
      return result;
    } finally {
      if (!streaming) {
        await finish();
      }
    }
  }
  protected override get image(): string {
    return this.env.__VOID_SANDBOX_IMAGE === 'cloudflare/debian-trixie'
      ? 'cloudflare/debian-trixie'
      : this.container.images.default;
  }
  protected override get entrypoint(): Array<string> | undefined {
    return this.image === 'cloudflare/debian-trixie' ? ['sleep', 'infinity'] : undefined;
  }
  protected override instanceType: SandboxInstance = 'lite';

  async #arm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }
  async #control(method: 'reserve' | 'started' | 'heartbeat', lease: Lease): Promise<void> {
    const result = await bounded(
      this.env.__VOID_SANDBOX_CONTROL[method](this.ctx.id.toString(), lease.generation),
    );
    if (!result.ok) {
      throw denied(result.reason);
    }
  }
  protected override async beforeStart(): Promise<void> {
    this.instanceType = this.env.__VOID_SANDBOX_INSTANCE ?? 'lite';
    let lease = await this.ctx.storage.get<Lease>(LEASE_KEY);
    if (lease?.phase === 'running' && this.container.running) {
      await this.#control('heartbeat', lease);
      await this.#arm();
      return;
    }
    if (lease) {
      if (this.container.running) {
        await this.container.destroy();
      }
      await this.stopped();
    }
    // A container with no durable admission record must never be adopted.
    if (this.container.running) {
      await this.container.destroy();
    }
    this.#generation = {};
    lease = { generation: crypto.randomUUID(), phase: 'pending' };
    await this.ctx.storage.put(LEASE_KEY, lease);
    await this.#arm();
    await this.#control('reserve', lease);
  }
  protected override async initialize(): Promise<void> {
    await super.initialize();
    if (this.env.__VOID_SANDBOX_IMAGE === 'cloudflare/debian-trixie') {
      const bytes = await getSandboxShim();
      const result = await this.initializationOutput(
        [
          'node',
          '-e',
          'const fs=require("node:fs");const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>{const path="/usr/local/bin/sandbox-shim-"+require("node:crypto").randomUUID();fs.writeFileSync(path,Buffer.concat(chunks),{mode:0o755});fs.renameSync(path,"/usr/local/bin/sandbox-shim");});',
        ],
        { stdin: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() },
        30_000,
      );
      if (result.exitCode !== 0) {
        throw denied('unavailable');
      }
    }
  }
  protected override async afterStart(): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);
    if (!lease || lease.phase === 'stopped' || !this.container.running) {
      throw denied('unavailable');
    }
    if (lease.phase === 'pending') {
      await this.#control('started', lease);
      await this.ctx.storage.put(LEASE_KEY, { ...lease, phase: 'running' } satisfies Lease);
      await this.#touch();
    }
    await this.#arm();
  }
  protected override async beforeUse(): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);
    if (!lease || lease.phase !== 'running') {
      throw denied('unavailable');
    }
    try {
      await this.#control('heartbeat', lease);
    } catch (error) {
      this.#generation.failure = error instanceof Error ? error : denied('unavailable');
      await this.destroy().catch(() => {});
      throw error;
    }
  }
  protected override async stopped(): Promise<void> {
    if (this.#finishing) {
      return this.#finishing;
    }
    const pending = (async () => {
      if (this.container.running) {
        return;
      }
      const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);
      if (!lease) {
        return;
      }
      await this.ctx.storage.put(LEASE_KEY, { ...lease, phase: 'stopped' } satisfies Lease);
      await this.#arm();
      await bounded(
        this.env.__VOID_SANDBOX_CONTROL.stopped(this.ctx.id.toString(), lease.generation),
      );
      await this.ctx.storage.delete(LEASE_KEY);
      await this.ctx.storage.delete(ACTIVITY_KEY);
      this.#activity = undefined;
      await this.ctx.storage.deleteAlarm();
    })();
    this.#finishing = pending;
    try {
      await pending;
    } finally {
      if (this.#finishing === pending) {
        this.#finishing = undefined;
      }
    }
  }
  async alarm(): Promise<void> {
    try {
      const lease = await this.ctx.storage.get<Lease>(LEASE_KEY);
      if (!lease) {
        return;
      }
      if (lease.phase === 'running' && this.container.running) {
        await this.#loadActivity();
        if (!this.#activity) {
          await this.#touch();
        }
        if (this.#busy === 0 && this.#activity && Date.now() >= this.#activity.idleDeadline) {
          await this.destroy();
          return;
        }
        await this.#control('heartbeat', lease);
      } else if (lease.phase !== 'pending' || !this.starting) {
        await this.destroy();
      }
    } catch (error) {
      this.#generation.failure = error instanceof Error ? error : denied('unavailable');
      await this.destroy().catch(() => {});
      console.error('[void/sandbox] lifecycle check failed', error);
    } finally {
      if (await this.ctx.storage.get(LEASE_KEY)) {
        await this.#arm();
      }
    }
  }
}
