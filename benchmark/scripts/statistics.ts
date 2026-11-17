export const bootstrapMethod = {
  method: 'percentile bootstrap',
  confidenceLevel: 0.95,
  resamples: 10_000,
  seed: 0x766f6964,
  quantiles: 'linear interpolation (R-7)',
  relativeHalfWidthTarget: 0.05,
  assumptions: 'IID resampling; intervals describe this batch, not independent environments.',
} as const;

export function quantile(sorted: Array<number>, probability: number) {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[Math.ceil(index)] * weight;
}

export function summarizeSamples(samples: Array<number | null | undefined>) {
  const values = samples
    .filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    )
    .sort((a, b) => a - b);
  const count = values.length;
  const missing = samples.length - count;
  if (!count) {
    return {
      count,
      missing,
      mean: null,
      median: null,
      standardDeviation: null,
      min: null,
      max: null,
      q1: null,
      q3: null,
      iqr: null,
      meanCI95: null,
      medianCI95: null,
      relativeMeanCIHalfWidth: null,
      meetsPrecisionTarget: null,
    };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const median = quantile(values, 0.5);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const standardDeviation =
    count > 1
      ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1))
      : null;
  let meanCI95: [number, number] | null = null;
  let medianCI95: [number, number] | null = null;
  if (count > 1) {
    // Reset the deterministic PRNG per metric: summaries are independently reproducible.
    let state: number = bootstrapMethod.seed;
    const means: Array<number> = [];
    const medians: Array<number> = [];
    for (let iteration = 0; iteration < bootstrapMethod.resamples; iteration++) {
      const sample = Array.from({ length: count }, () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return values[Math.floor((state / 0x1_0000_0000) * count)];
      });
      means.push(sample.reduce((sum, value) => sum + value, 0) / count);
      sample.sort((a, b) => a - b);
      medians.push(quantile(sample, 0.5));
    }
    means.sort((a, b) => a - b);
    medians.sort((a, b) => a - b);
    meanCI95 = [quantile(means, 0.025), quantile(means, 0.975)];
    medianCI95 = [quantile(medians, 0.025), quantile(medians, 0.975)];
  }
  const relativeMeanCIHalfWidth =
    meanCI95 && mean > 0 ? (meanCI95[1] - meanCI95[0]) / (2 * mean) : null;
  return {
    count,
    missing,
    mean,
    median,
    standardDeviation,
    min: values[0],
    max: values.at(-1)!,
    q1,
    q3,
    iqr: q3 - q1,
    meanCI95,
    medianCI95,
    relativeMeanCIHalfWidth,
    meetsPrecisionTarget:
      relativeMeanCIHalfWidth === null
        ? null
        : relativeMeanCIHalfWidth <= bootstrapMethod.relativeHalfWidthTarget,
  };
}

export function parseRunCount(value: string, flag: string) {
  const runs = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(runs) || runs < 1 || runs > 1000) {
    throw new Error(`${flag} must be an integer between 1 and 1000.`);
  }
  return runs;
}
