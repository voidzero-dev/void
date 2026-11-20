import { bootstrapMethod, quantile } from './statistics.ts';

export const latencyBootstrapMethod = {
  ...bootstrapMethod,
  unit: 'whole round',
  estimand: 'request-weighted pooled mean and pooled request percentiles',
  assumptions:
    'Rounds are exchangeable independent clusters; within-round observations remain together. Sequential rounds may still be correlated.',
} as const;

// Keep each round intact. Averaging round percentiles would estimate a different
// quantity from the pooled request percentile reported here.
export function summarizeLatencyRounds(rounds: Array<Array<number>>) {
  if (
    !rounds.length ||
    rounds.some(
      (round) => !round.length || round.some((value) => !Number.isFinite(value) || value < 0),
    )
  ) {
    throw new Error('Expected nonempty rounds of finite nonnegative request durations.');
  }
  const observations = rounds
    .flatMap((round, index) => round.map((value) => ({ value, round: index })))
    .sort((a, b) => a.value - b.value);
  const values = observations.map(({ value }) => value);
  const sums = rounds.map((round) => round.reduce((sum, value) => sum + value, 0));
  const estimates = {
    mean: sums.reduce((sum, value) => sum + value, 0) / values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
  };
  const bootstrap = {
    mean: [] as Array<number>,
    p50: [] as Array<number>,
    p95: [] as Array<number>,
  };
  if (rounds.length > 1) {
    let state: number = latencyBootstrapMethod.seed;
    for (let iteration = 0; iteration < latencyBootstrapMethod.resamples; iteration++) {
      const weights = new Array<number>(rounds.length).fill(0);
      let total = 0;
      let sum = 0;
      for (let draw = 0; draw < rounds.length; draw++) {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        const index = Math.floor((state / 0x1_0000_0000) * rounds.length);
        weights[index]++;
        total += rounds[index].length;
        sum += sums[index];
      }
      bootstrap.mean.push(sum / total);
      // Weighted order statistics avoid expanding and sorting every resample.
      const positions = [0.5, 0.95]
        .flatMap((p) => {
          const position = (total - 1) * p;
          return [Math.floor(position), Math.ceil(position)];
        })
        .map((position, index) => ({ position, index }))
        .sort((a, b) => a.position - b.position);
      const selected = new Array<number>(4);
      let cumulative = 0;
      let next = 0;
      for (const observation of observations) {
        cumulative += weights[observation.round];
        while (next < positions.length && cumulative > positions[next].position) {
          selected[positions[next].index] = observation.value;
          next++;
        }
        if (next === positions.length) {
          break;
        }
      }
      for (const [index, key] of (['p50', 'p95'] as const).entries()) {
        const position = (total - 1) * (key === 'p50' ? 0.5 : 0.95);
        const fraction = position - Math.floor(position);
        bootstrap[key].push(
          selected[index * 2] * (1 - fraction) + selected[index * 2 + 1] * fraction,
        );
      }
    }
  }
  function metric(key: keyof typeof estimates) {
    const samples = bootstrap[key].sort((a, b) => a - b);
    const ci95: [number, number] | null = samples.length
      ? [quantile(samples, 0.025), quantile(samples, 0.975)]
      : null;
    const estimate = estimates[key];
    const relativeCIHalfWidth = ci95 && estimate > 0 ? (ci95[1] - ci95[0]) / (2 * estimate) : null;
    return {
      estimate,
      ci95,
      relativeCIHalfWidth,
      meetsPrecisionTarget:
        relativeCIHalfWidth === null
          ? null
          : relativeCIHalfWidth <= bootstrapMethod.relativeHalfWidthTarget,
    };
  }
  return {
    rounds: rounds.length,
    requests: values.length,
    units: 'seconds',
    bootstrap: latencyBootstrapMethod,
    metrics: { mean: metric('mean'), p50: metric('p50'), p95: metric('p95') },
    min: values[0],
    max: values.at(-1)!,
    p99: quantile(values, 0.99),
  };
}
