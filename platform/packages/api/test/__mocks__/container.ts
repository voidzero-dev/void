// Fake `ctx.container` for the security scanner controller tests (design doc 0095).
// Records every call in order, keeps a tiny file map for the result reader
// (`node -e <reader> <path> <limit>`), and lets a test script what each command prints.

export type FakeExecCall = Readonly<{
  argv: ReadonlyArray<string>;
  options: ContainerExecOptions | undefined;
  /** Bytes the command read from stdin (a stream, or a piped `stdin`). */
  stdin: () => Promise<string>;
}>;

export type FakeExecResult = Readonly<{ exitCode: number; stdout?: string; stderr?: string }>;

export type FakeContainerOptions = {
  /** Answers a command; return undefined for the default answer. */
  exec?: (call: FakeExecCall) => FakeExecResult | undefined | Promise<FakeExecResult | undefined>;
  /** `exec(['true'])` fails this many times before the container is ready. */
  notReadyFor?: number;
};

const encoder = new TextEncoder();

function buffer(text: string | undefined): ArrayBuffer {
  return encoder.encode(text ?? '').buffer as ArrayBuffer;
}

export function createFakeContainer(options: FakeContainerOptions = {}) {
  const calls: Array<string> = [];
  const intercepts: Array<{ kind: 'host' | 'all' | 'https'; addr?: string; binding: unknown }> = [];
  const execs: Array<FakeExecCall> = [];
  const files = new Map<string, string>();
  /** Paths that are a symlink or not a regular file: the reader refuses them (exit 3). */
  const unsafe = new Set<string>();
  let startOptions: ContainerStartupOptions | undefined;
  let notReady = options.notReadyFor ?? 0;
  let nextPid = 100;

  const container = {
    running: false,
    images: {} as Record<string, string>,
    async interceptOutboundHttp(addr: string, binding: Fetcher) {
      calls.push(`interceptOutboundHttp:${addr}`);
      intercepts.push({ kind: 'host', addr, binding });
    },
    async interceptAllOutboundHttp(binding: Fetcher) {
      calls.push('interceptAllOutboundHttp');
      intercepts.push({ kind: 'all', binding });
    },
    async interceptOutboundHttps(addr: string, binding: Fetcher) {
      calls.push(`interceptOutboundHttps:${addr}`);
      intercepts.push({ kind: 'https', addr, binding });
    },
    start(start: ContainerStartupOptions) {
      calls.push('start');
      startOptions = start;
      container.running = true;
    },
    async destroy() {
      calls.push('destroy');
      container.running = false;
    },
    async setInactivityTimeout() {},
    signal() {},
    async exec(argv: Array<string>, execOptions?: ContainerExecOptions) {
      if (!container.running) {
        throw new Error('container is not running');
      }
      calls.push(`exec:${argv[0]}${argv[1] ? ` ${argv[1]}` : ''}`);
      const chunks: Array<Uint8Array> = [];
      let piped: Promise<void> = Promise.resolve();
      let stdinWritable: WritableStream | null = null;
      if (execOptions?.stdin instanceof ReadableStream) {
        const reader = execOptions.stdin.getReader();
        piped = (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              return;
            }
            chunks.push(value as Uint8Array);
          }
        })();
      } else if (execOptions?.stdin === 'pipe') {
        let close!: () => void;
        piped = new Promise<void>((resolve) => (close = resolve));
        stdinWritable = new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(chunk);
          },
          close() {
            close();
          },
        });
      }
      const call: FakeExecCall = {
        argv,
        options: execOptions,
        stdin: async () => {
          await piped;
          return new TextDecoder().decode(
            chunks.reduce((all, chunk) => {
              const next = new Uint8Array(all.length + chunk.length);
              next.set(all);
              next.set(chunk, all.length);
              return next;
            }, new Uint8Array()),
          );
        },
      };
      execs.push(call);
      let result: FakeExecResult | undefined;
      if (argv[0] === 'true' && notReady > 0) {
        notReady--;
        throw new Error('container is starting');
      }
      result = await options.exec?.(call);
      if (!result) {
        if (argv[0] === 'node' && argv[1] === '-e' && argv.length === 5) {
          const path = argv[3]!;
          const text = files.get(path);
          result = unsafe.has(path)
            ? { exitCode: 3 }
            : text === undefined
              ? { exitCode: 1 }
              : { exitCode: 0, stdout: text.slice(0, Number(argv[4])) };
        } else {
          result = { exitCode: 0 };
        }
      }
      const final = result;
      return {
        pid: nextPid++,
        isPty: false,
        stdin: stdinWritable,
        stdout: null,
        stderr: null,
        exitCode: Promise.resolve(final.exitCode),
        output: async () => {
          if (execOptions?.stdin instanceof ReadableStream) {
            await piped;
          }
          return {
            exitCode: final.exitCode,
            stdout: buffer(final.stdout),
            stderr: buffer(final.stderr),
          };
        },
        kill() {},
        resize() {},
      };
    },
  };

  return {
    container,
    calls,
    intercepts,
    execs,
    files,
    unsafe,
    started: () => startOptions,
  };
}

export type FakeContainer = ReturnType<typeof createFakeContainer>;
