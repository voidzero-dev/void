/** Revalidate every delivered chunk; idle streams also close when their session is revoked. */
export function guardHumanStream<Chunk>(
  source: ReadableStream<Chunk>,
  validate: () => Promise<boolean>,
  signal?: AbortSignal,
): ReadableStream<Chunk> {
  const reader = source.getReader();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Chunk>;
  const cleanup = () => {
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    signal?.removeEventListener('abort', abort);
  };
  const stop = () => {
    if (closed) {
      return;
    }
    cleanup();
    controller.error(new Error('Authentication expired or was revoked. Sign in again.'));
    void reader.cancel().catch(() => {});
  };
  const abort = () => stop();
  const check = async () => {
    if (closed) {
      return false;
    }
    try {
      if (await validate()) {
        return !closed;
      }
    } catch {
      /* Failed authority reads must close the stream. */
    }
    stop();
    return false;
  };
  const schedule = () => {
    timer = setTimeout(async () => {
      if (await check()) {
        schedule();
      }
    }, 15_000);
  };
  return new ReadableStream<Chunk>(
    {
      start(target) {
        controller = target;
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
          stop();
        } else {
          schedule();
        }
      },
      async pull(target) {
        try {
          const chunk = await reader.read();
          if (closed) {
            return;
          }
          if (chunk.done) {
            cleanup();
            target.close();
          } else if (await check()) {
            target.enqueue(chunk.value);
          }
        } catch (error) {
          if (!closed) {
            cleanup();
            target.error(error);
            void reader.cancel().catch(() => {});
          }
        }
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
