export function concatStreams(
  streams: ReadonlyArray<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;

  const cancelRemaining = async (reason: unknown) => {
    const cancellations: Array<Promise<unknown>> = [];
    if (reader) {
      cancellations.push(reader.cancel(reason));
    }
    for (let remaining = index + (reader ? 1 : 0); remaining < streams.length; remaining++) {
      cancellations.push(streams[remaining].cancel(reason));
    }
    await Promise.allSettled(cancellations);
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (index < streams.length) {
            reader ??= streams[index].getReader();
            const { done, value } = await reader.read();
            if (cancelled) {
              return;
            }
            if (done) {
              reader.releaseLock();
              reader = undefined;
              index++;
              continue;
            }
            controller.enqueue(value);
            return;
          }
          controller.close();
        } catch (error) {
          if (!cancelled) {
            controller.error(error);
            await cancelRemaining(error);
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        await cancelRemaining(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
