/** Stable across checkout directories and Windows/POSIX path separators. */
export function testFileKey(file: string, root: string): string {
  const path = file.replaceAll('\\', '/');
  const prefix = `${root.replaceAll('\\', '/').replace(/\/$/, '')}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Preserve reproducible --sequence.shuffle.files runs with a custom sequencer. */
export function shuffleTests<T>(tests: ReadonlyArray<T>, seed: number): Array<T> {
  const shuffled = [...tests];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const other = state % (index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

/** Longest-first greedy packing; every discovered test appears in exactly one shard. */
export function balanceTests<T>(
  tests: ReadonlyArray<T>,
  count: number,
  key: (test: T) => string,
  duration: (test: T) => number,
): Array<Array<T>> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Shard count must be a positive integer.');
  }
  const shards = Array.from({ length: count }, () => ({ tests: [] as Array<T>, duration: 0 }));
  const sorted = [...tests].sort(
    (a, b) => duration(b) - duration(a) || compareKeys(key(a), key(b)),
  );
  for (const test of sorted) {
    const shard = shards.reduce((best, candidate) =>
      candidate.duration < best.duration ||
      (candidate.duration === best.duration && candidate.tests.length < best.tests.length)
        ? candidate
        : best,
    );
    shard.tests.push(test);
    shard.duration += duration(test);
  }
  return shards.map(({ tests }) => tests);
}
