export const R2_CONCURRENCY = 6;

export async function uploadPool<T, Result>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T) => Promise<Result>,
): Promise<void> {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
