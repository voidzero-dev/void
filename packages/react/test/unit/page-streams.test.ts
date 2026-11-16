import { expect, it, vi } from 'vite-plus/test';
import { concatStreams } from '../../src/runtime/page-streams.ts';

const encoder = new TextEncoder();

function chunkStream(chunks: ReadonlyArray<string>, onCancel?: (reason: unknown) => void) {
  let next = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (next === chunks.length) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(chunks[next++]));
        }
      },
      cancel: onCancel,
    },
    { highWaterMark: 0 },
  );
}

it('concatenates streams in order without reading ahead of the consumer', async () => {
  let pulls = 0;
  const first = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (pulls <= 32) {
          controller.enqueue(encoder.encode('a'));
        } else {
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
  const joined = concatStreams([first, chunkStream(['b', 'c'])]);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pulls).toBeLessThan(4);
  expect(await new Response(joined).text()).toBe(`${'a'.repeat(32)}bc`);
});

it('cancels the active and unopened streams when the consumer stops', async () => {
  const cancelActive = vi.fn();
  const cancelUnopened = vi.fn();
  const joined = concatStreams([
    chunkStream(
      Array.from({ length: 32 }, () => 'a'),
      cancelActive,
    ),
    chunkStream(['b'], cancelUnopened),
  ]);
  const reader = joined.getReader();

  expect((await reader.read()).value).toEqual(encoder.encode('a'));
  await reader.cancel('stopped');
  expect(cancelActive).toHaveBeenCalledWith('stopped');
  expect(cancelUnopened).toHaveBeenCalledWith('stopped');
});
