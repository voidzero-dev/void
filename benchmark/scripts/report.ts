import fs from 'node:fs';
import path from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { DeploymentStats } from './deploy.ts';
import type { summarizeLatencyRounds } from './latency-statistics.ts';
import type { LatencyRound } from './latency.ts';
import { quantile } from './statistics.ts';

type Machine = {
  hostnameSha256?: string;
  platform?: string;
  cpu?: {
    models?: Array<string>;
    architecture?: string;
    logicalCores?: number | null;
    availableParallelism?: number;
  };
  network?: { type?: string; interface?: string | null };
};

type Result = {
  benchmark: string;
  startedAt: string;
  finishedAt: string;
  artifacts?: string;
  runtime: { node: string; osRelease: string };
  machine?: Machine;
  deploy: {
    workerName: string;
    workerId: string;
    versionId: string;
    url: string;
    artifacts?: string;
    status?: string;
    batch?: Omit<NonNullable<DeploymentStats['batch']>, 'runs'> & {
      runs: Array<
        Pick<DeploymentStats, 'status' | 'startedAt' | 'finishedAt' | 'bundle' | 'versionId'> & {
          timings: NonNullable<Result['deploy']['timings']>;
        }
      >;
    };
    bundle?: { rawBytes?: number; gzipBytes?: number };
    timings?: {
      buildReportedMs?: number | null;
      uploadReportedMs?: number | null;
      triggersReportedMs?: number | null;
      workerStartupMs?: number | null;
      cfDeployWallMs?: number | null;
      workflowWallMs?: number | null;
      accessWallMs?: number | null;
      cleanWallMs?: number | null;
      workerLookupWallMs?: number | null;
    };
  };
  latency?: {
    url: string;
    artifacts?: string;
    status?: string;
    measurementStartedAt?: string;
    measurementFinishedAt?: string;
    runs?: Array<
      Pick<LatencyRound, 'status' | 'measurementStartedAt' | 'measurementFinishedAt'> & {
        oha?: NonNullable<Result['latency']>['oha'];
      }
    >;
    statistics?: ReturnType<typeof summarizeLatencyRounds>;
    ohaVersion?: string;
    settings: {
      requests?: number | null;
      runs?: number;
      duration?: string | null;
      connections?: number;
      rate?: number | null;
      timeout?: string;
      httpVersion?: string;
      keepAlive?: boolean;
      warmupRequests?: number;
      access?: string;
      request?: { method?: string; status?: number; bodyBytes?: number };
    };
    oha: {
      summary: Record<string, number>;
      latencyPercentiles: Record<string, number>;
      statusCodeDistribution: Record<string, number>;
    };
  };
  metrics?: {
    status?: string;
    artifacts?: string;
    window: { requested: { start: string; end: string }; queried: { start: string; end: string } };
    units: { wallTime: string | null };
    metrics: {
      sum: Record<string, number>;
      quantiles: Record<string, number | null>;
    };
  };
  settings: { metricsPaddingMs: number; metricsWaitMs: number; metricsIntervalMs: number };
  quietAttempts: number;
  metricsAttempts: number;
  latencyWorkloads?: Array<{
    id: string;
    description: string;
    status?: string;
    latency: NonNullable<Result['latency']>;
    metrics: NonNullable<Result['metrics']>;
    quietAttempts?: number;
    resultAttempts?: number;
    metricsQuietAttempts?: Array<unknown>;
    metricsAttempts?: Array<unknown>;
  }>;
};

// Render only selected fields, never environment variables, command output, or credentials.
export function renderBenchmarkReport(result: Result) {
  const workloads: NonNullable<Result['latencyWorkloads']> =
    result.latencyWorkloads ??
    (result.latency && result.metrics
      ? [
          {
            id: 'latency',
            description: 'Recorded latency workload',
            latency: result.latency,
            metrics: result.metrics,
            quietAttempts: result.quietAttempts,
            resultAttempts: result.metricsAttempts,
          },
        ]
      : []);
  const sections = renderSections({
    ...result,
    latency: workloads[0]?.latency,
    metrics: workloads[0]?.metrics,
  });
  const workloadSections = workloads.map((workload) => ({
    workload,
    sections: renderSections({
      ...result,
      latency: workload.latency,
      metrics: workload.metrics,
      quietAttempts: workload.quietAttempts ?? workload.metricsQuietAttempts?.length ?? 0,
      metricsAttempts: workload.resultAttempts ?? workload.metricsAttempts?.length ?? 0,
    }),
  }));
  const settings = workloadSections
    .map(({ workload, sections }) => `\n### ${escapeCell(workload.id)}\n\n${sections.settings}`)
    .join('');
  const introduction = `${sections.title}
<details>
<summary>Show context and workload</summary>

${sections.context}
${settings ? `\n## Workload\n\n${settings}` : ''}

</details>
`;
  const number = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value)
      ? 'Unavailable'
      : `${(value * 1000).toFixed(3)} ms`;
  const summary = workloads.length
    ? `
## Latency workload summary

| Workload | URL | Mean | P50 | P95 |
| --- | --- | --- | --- | --- |
${workloads.map((workload) => `| ${escapeCell(workload.id)} | ${escapeCell(workload.latency.url)} | ${number(workload.latency.oha.summary.average)} | ${number(workload.latency.oha.latencyPercentiles.p50)} | ${number(workload.latency.oha.latencyPercentiles.p95)} |`).join('\n')}

### Details

<details>
<summary>Show details</summary>

#### Workload methodology

Workloads execute sequentially in the listed order. Shared caches and changing network/load conditions can affect comparisons. Confidence intervals describe each workload, not statistical significance between workloads.

</details>
`
    : '\n## Latency\n\nNo latency workloads were requested; no request load or Worker analytics queries were performed.\n';
  return (
    introduction +
    sections.deployment +
    summary +
    workloadSections
      .map(({ workload, sections }) => {
        const detail = sections.workload.replace(/^(#{2,}) /gm, '#$1 ');
        const heading = workloads.length === 1 ? 'Latency' : `Latency - ${escapeCell(workload.id)}`;
        return `\n## ${heading}\n\n${escapeCell(workload.description)}\n${detail}`;
      })
      .join('')
  );
}

function escapeCell(value: unknown) {
  return String(value ?? 'Unavailable')
    .replaceAll('|', '\\|')
    .replace(/[\r\n]/g, ' ')
    .replaceAll('<', '&lt;');
}

function pick<T, K extends keyof T>(
  value: T,
  keys: ReadonlyArray<K>,
): T extends unknown ? Pick<T, K> : never {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as T extends unknown
    ? Pick<T, K>
    : never;
}

// Public, portable render input. Never copy entire private records: they can contain
// request headers/bodies, command arguments, local paths, or authentication output.
export function createReportSnapshot(result: Result) {
  const timings = (value: NonNullable<Result['deploy']['timings']>) =>
    pick(value, [
      'buildReportedMs',
      'uploadReportedMs',
      'triggersReportedMs',
      'workerStartupMs',
      'cfDeployWallMs',
      'workflowWallMs',
      'accessWallMs',
      'cleanWallMs',
      'workerLookupWallMs',
    ]);
  const bundle = <T extends NonNullable<Result['deploy']['bundle']>>(value: T) =>
    pick(value, ['rawBytes', 'gzipBytes']);
  const bootstrapKeys = [
    'method',
    'confidenceLevel',
    'resamples',
    'seed',
    'quantiles',
    'relativeHalfWidthTarget',
    'assumptions',
  ] as const;
  const numericRecord = (value: Record<string, number | null>) =>
    Object.fromEntries(
      Object.entries(value).filter(([, item]) => item === null || typeof item === 'number'),
    );
  const oha = (value: NonNullable<Result['latency']>['oha']) => ({
    summary: numericRecord(value.summary) as Record<string, number>,
    latencyPercentiles: numericRecord(value.latencyPercentiles) as Record<string, number>,
    statusCodeDistribution: numericRecord(value.statusCodeDistribution) as Record<string, number>,
  });
  const latencyMetric = (
    value: NonNullable<NonNullable<Result['latency']>['statistics']>['metrics']['mean'],
  ) => pick(value, ['estimate', 'ci95', 'relativeCIHalfWidth', 'meetsPrecisionTarget']);
  const latency = (value: NonNullable<Result['latency']>) => ({
    status: 'success' as const,
    ...pick(value, ['url', 'ohaVersion', 'measurementStartedAt', 'measurementFinishedAt']),
    settings: {
      ...pick(value.settings, [
        'requests',
        'runs',
        'duration',
        'connections',
        'rate',
        'timeout',
        'httpVersion',
        'keepAlive',
        'warmupRequests',
        'access',
      ]),
      request:
        value.settings.request && pick(value.settings.request, ['method', 'status', 'bodyBytes']),
    },
    oha: oha(value.oha),
    runs: value.runs?.map((run) => ({
      ...pick(run, ['status', 'measurementStartedAt', 'measurementFinishedAt']),
      oha: run.oha && oha(run.oha),
    })),
    statistics: value.statistics && {
      ...pick(value.statistics, ['rounds', 'requests', 'units', 'min', 'max', 'p99']),
      bootstrap: pick(value.statistics.bootstrap, [...bootstrapKeys, 'unit', 'estimand']),
      metrics: {
        mean: latencyMetric(value.statistics.metrics.mean),
        p50: latencyMetric(value.statistics.metrics.p50),
        p95: latencyMetric(value.statistics.metrics.p95),
      },
    },
  });
  const metrics = (value: NonNullable<Result['metrics']>) => ({
    status: 'success' as const,
    window: {
      requested: pick(value.window.requested, ['start', 'end']),
      queried: pick(value.window.queried, ['start', 'end']),
    },
    units: { cpuTime: 'microseconds', wallTime: 'microseconds', memoryUsageBytes: 'bytes' },
    metrics: {
      sum: numericRecord(value.metrics.sum) as Record<string, number>,
      quantiles: numericRecord(value.metrics.quantiles),
    },
  });
  const batch = result.deploy.batch;
  return {
    kind: 'void-benchmark-report',
    schemaVersion: 1,
    status: 'success',
    ...pick(result, ['benchmark', 'startedAt', 'finishedAt', 'quietAttempts', 'metricsAttempts']),
    runtime: pick(result.runtime, ['node', 'osRelease']),
    machine: result.machine && {
      ...pick(result.machine, ['hostnameSha256', 'platform']),
      cpu:
        result.machine.cpu &&
        pick(result.machine.cpu, [
          'models',
          'architecture',
          'logicalCores',
          'availableParallelism',
        ]),
      network: result.machine.network && pick(result.machine.network, ['type', 'interface']),
    },
    settings: pick(result.settings, ['metricsPaddingMs', 'metricsWaitMs', 'metricsIntervalMs']),
    deploy: {
      status: 'success',
      ...pick(result.deploy, ['workerName', 'workerId', 'versionId', 'url']),
      timings: result.deploy.timings && timings(result.deploy.timings),
      bundle: result.deploy.bundle && bundle(result.deploy.bundle),
      batch: batch && {
        ...pick(batch, [
          'requestedRuns',
          'completedRuns',
          'failedRuns',
          'notRun',
          'startedAt',
          'finishedAt',
        ]),
        bootstrap: pick(batch.bootstrap, bootstrapKeys),
        statistics: Object.fromEntries(
          Object.entries(batch.statistics).map(([key, value]) => [
            key,
            pick(value, [
              'count',
              'missing',
              'mean',
              'median',
              'standardDeviation',
              'min',
              'max',
              'q1',
              'q3',
              'iqr',
              'meanCI95',
              'medianCI95',
              'relativeMeanCIHalfWidth',
              'meetsPrecisionTarget',
            ]),
          ]),
        ),
        bundle: Object.fromEntries(
          Object.entries(batch.bundle).map(([key, value]) => [
            key,
            pick(value, ['count', 'min', 'max']),
          ]),
        ),
        runs: batch.runs.map((run) => ({
          ...pick(run, ['status', 'startedAt', 'finishedAt', 'versionId']),
          timings: timings(run.timings),
          bundle: run.bundle && bundle(run.bundle),
        })),
      },
    },
    latency:
      result.latencyWorkloads === undefined && result.latency ? latency(result.latency) : undefined,
    metrics:
      result.latencyWorkloads === undefined && result.metrics ? metrics(result.metrics) : undefined,
    latencyWorkloads: result.latencyWorkloads?.map((workload) => ({
      ...pick(workload, ['id', 'description']),
      status: 'success',
      latency: latency(workload.latency),
      metrics: metrics(workload.metrics),
      quietAttempts: workload.quietAttempts ?? workload.metricsQuietAttempts?.length ?? 0,
      resultAttempts: workload.resultAttempts ?? workload.metricsAttempts?.length ?? 0,
    })),
  };
}

// Stage both files before replacing either. Roll back replacements if publication
// fails, so a failed run does not leave the previous report paired with new data.
export function writeBenchmarkReport(app: string, result: Result) {
  const snapshot = createReportSnapshot(result);
  const files = ['report.json', 'report.md'];
  for (const file of files) {
    const target = path.join(app, file);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing to use a symlink: ${target}`);
    }
    if (stat && !stat.isFile()) {
      throw new Error(`Expected a regular file: ${target}`);
    }
  }
  const temporary = fs.mkdtempSync(path.join(app, '.report-'));
  const replaced: Array<string> = [];
  try {
    fs.writeFileSync(
      path.join(temporary, 'report.json'),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(temporary, 'report.md'), renderBenchmarkReport(snapshot), {
      mode: 0o600,
    });
    for (const file of files) {
      const target = path.join(app, file);
      if (fs.existsSync(target)) {
        fs.linkSync(target, path.join(temporary, `${file}.previous`));
      }
    }
    for (const file of files) {
      fs.renameSync(path.join(temporary, file), path.join(app, file));
      replaced.push(file);
    }
  } catch (error) {
    for (const file of replaced.reverse()) {
      const previous = path.join(temporary, `${file}.previous`);
      if (fs.existsSync(previous)) {
        fs.renameSync(previous, path.join(app, file));
      } else {
        fs.unlinkSync(path.join(app, file));
      }
    }
    throw error;
  } finally {
    for (const file of files) {
      fs.rmSync(path.join(temporary, file), { force: true });
      fs.rmSync(path.join(temporary, `${file}.previous`), { force: true });
    }
    fs.rmdirSync(temporary);
  }
  return path.join(app, 'report.md');
}

function renderSections(result: Result) {
  const escape = (value: unknown) =>
    value === undefined || value === null || value === '' ? 'Unavailable' : escapeCell(value);
  const number = (value: number | null | undefined, digits = 2) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString('en-US', { maximumFractionDigits: digits })
      : 'Unavailable';
  const measurement = (value: number | null | undefined, unit: string, digits = 3) =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${number(value, digits)} ${unit}`
      : 'Unavailable';
  const range = (
    min: number | null | undefined,
    max: number | null | undefined,
    unit: string,
    digits = 3,
  ) =>
    typeof min === 'number' &&
    Number.isFinite(min) &&
    typeof max === 'number' &&
    Number.isFinite(max)
      ? `${number(min, digits)}–${number(max, digits)} ${unit}`
      : 'Unavailable';
  const table = (rows: Array<[string, unknown]>) =>
    [
      '| Field | Value |',
      '| --- | --- |',
      ...rows.map(([key, value]) => `| ${key} | ${escape(value)} |`),
    ].join('\n');
  const { deploy, latency, metrics, machine } = result;
  const { summary = {}, latencyPercentiles = {} } = latency?.oha ?? {};
  const settings = latency?.settings ?? {};
  const quantiles = metrics?.metrics.quantiles ?? {};
  const percentiles = ['P50', 'P90', 'P99', 'P999'];
  const metricRow = (name: string, prefix: string, unit: string, divisor = 1) =>
    `| ${name} | ${percentiles
      .map((p) => {
        const value = quantiles[prefix + p];
        return measurement(value === null || value === undefined ? null : value / divisor, unit);
      })
      .join(' | ')} |`;
  const interval = (value: [number, number] | null) =>
    value && value.every(Number.isFinite)
      ? `[${number(value[0], 3)}, ${number(value[1], 3)}] ms`
      : 'Unavailable';
  const batch = deploy.batch;
  const bundleMedian = (key: 'rawBytes' | 'gzipBytes') => {
    if (!batch) {
      return deploy.bundle?.[key];
    }
    const sizes = batch.runs
      .filter((run) => run.status === 'success')
      .map((run) => run.bundle?.[key])
      .filter(
        (size): size is number => typeof size === 'number' && Number.isFinite(size) && size >= 0,
      )
      .sort((a, b) => a - b);
    return sizes.length ? quantile(sizes, 0.5) : undefined;
  };
  const latencyStatistics = latency?.statistics;
  const latencyConfidence = latencyStatistics
    ? `
#### Latency uncertainty

${latencyStatistics.rounds} rounds; ${number(latencyStatistics.requests, 0)} measured requests pooled. Confidence intervals resample whole rounds, retaining within-round dependence.

| Measurement | Estimate | 95% CI | CI half-width / estimate | ±5% target |
| --- | --- | --- | --- | --- |
${Object.entries(latencyStatistics.metrics)
  .map(
    ([key, metric]) =>
      `| ${key === 'mean' ? 'Mean' : key.toUpperCase()} | ${measurement(metric.estimate * 1000, 'ms')} | ${metric.ci95 ? interval([metric.ci95[0] * 1000, metric.ci95[1] * 1000]) : 'Unavailable'} | ${metric.relativeCIHalfWidth === null ? 'Unavailable' : `${number(metric.relativeCIHalfWidth * 100, 2)}%`} | ${metric.meetsPrecisionTarget === null ? 'Unavailable' : metric.meetsPrecisionTarget ? 'Met' : 'Not met'} |`,
  )
  .join('\n')}

95% percentile cluster-bootstrap intervals use ${number(latencyStatistics.bootstrap.resamples, 0)} resamples and seed ${latencyStatistics.bootstrap.seed}. Pooled request quantiles use R-7 interpolation; round percentiles are not averaged. At least two rounds are needed for intervals; ten rounds are a starting sample, not a guarantee of coverage or precision. Relative precision is unavailable for a zero estimate.

Rounds are assumed independent and exchangeable. Sequential rounds can still share network conditions, Cloudflare load, and caches; these intervals do not establish significance between implementations or accuracy across environments. P99 is descriptive only.

#### Latency rounds

| Round | Outcome | Measured requests | Measurement start (UTC) |
| --- | --- | --- | --- |
${(latency?.runs ?? [])
  .map((run, index) => {
    const count = run.oha
      ? Object.values(run.oha.statusCodeDistribution).reduce((sum, count) => sum + count, 0)
      : undefined;
    return `| ${index + 1} | ${escape(run.status)} | ${number(count, 0)} | ${escape(run.measurementStartedAt)} |`;
  })
  .join('\n')}

`
    : '';
  const labels: Record<string, string> = {
    buildReportedMs: 'Build',
    uploadReportedMs: 'Upload',
    triggersReportedMs: 'Deploy triggers',
    cfDeployWallMs: '`cf deploy`',
    cleanWallMs: 'Local preparation + cleanup',
    workerLookupWallMs: 'Worker lookup',
    workerStartupMs: 'Worker startup',
  };
  const primaryTimings = [
    'buildReportedMs',
    'uploadReportedMs',
    'workerStartupMs',
    'cfDeployWallMs',
  ] as const;
  const deploymentTimingSummary = batch
    ? `
### Timing summary

| Phase | Mean | Mean 95% CI | Median |
| --- | --- | --- | --- |
${primaryTimings
  .map((key) => {
    const value = batch.statistics[key];
    return `| ${labels[key]} | ${measurement(value?.mean, 'ms')} | ${interval(value?.meanCI95 ?? null)} | ${measurement(value?.median, 'ms')} |`;
  })
  .join('\n')}
`
    : `
### Timing summary

| Phase | Value |
| --- | --- |
${primaryTimings.map((key) => `| ${labels[key]} | ${measurement(deploy.timings?.[key], 'ms')} |`).join('\n')}
`;
  const deploymentTimingDetails = batch
    ? `
#### Full timing statistics

| Phase | Valid / missing | Mean | Mean 95% CI | Median | Median 95% CI | Sample SD | IQR | Min–max | Mean CI half-width / mean | ±5% target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${Object.entries(batch.statistics)
  .map(
    ([key, value]) =>
      `| ${labels[key] ?? escape(key)} | ${value.count} / ${value.missing} | ${measurement(value.mean, 'ms')} | ${interval(value.meanCI95)} | ${measurement(value.median, 'ms')} | ${interval(value.medianCI95)} | ${measurement(value.standardDeviation, 'ms')} | ${measurement(value.iqr, 'ms')} | ${range(value.min, value.max, 'ms')} | ${value.relativeMeanCIHalfWidth === null ? 'Unavailable' : `${number(value.relativeMeanCIHalfWidth * 100, 2)}%`} | ${value.meetsPrecisionTarget === null ? 'Unavailable' : value.meetsPrecisionTarget ? 'Met' : 'Not met'} |`,
  )
  .join('\n')}

#### Batch context

${table([
  [
    'Requested / completed / failed / not run',
    `${batch.requestedRuns} / ${batch.completedRuns} / ${batch.failedRuns} / ${batch.notRun}`,
  ],
  ['Batch start / finish (UTC)', `${batch.startedAt} / ${batch.finishedAt}`],
])}

#### Timing methodology

Build is the CLI-reported bundle sum, not the complete build workflow. Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total measures the complete cf deploy invocation through successful completion, including build; it excludes subsequent Worker lookup and Access setup. These measurements overlap and must not be added together.

95% percentile bootstrap intervals use ${number(batch.bootstrap.resamples, 0)} resamples, seed ${batch.bootstrap.seed}, and linear-interpolated quantiles (R-7). Sample SD uses n−1. Intervals require at least two valid observations; relative precision is unavailable for a zero mean.

Only successful run workflows contribute to aggregates. Failed/missing measurements are counted; unattempted runs are listed separately. The first run and all successful outliers are included. No deployment P95/P99 is estimated.

These IID bootstrap intervals describe uncertainty within this sequential batch, not independent environments or statistical significance between implementations. Shared caches, network conditions, and Cloudflare load can correlate observations. A narrow interval, especially for rounded CLI timings, is not proof of general accuracy.

#### Individual deployments

| Run | Outcome | Started (UTC) | Build | Upload | Deploy triggers | \`cf deploy\` | Raw / gzip | Version |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${batch.runs
  .map((run, index) => {
    return `| ${index + 1}${index === 0 ? ' (first)' : ''} | ${escape(run.status)} | ${escape(run.startedAt)} | ${measurement(run.timings.buildReportedMs, 'ms')} | ${measurement(run.timings.uploadReportedMs, 'ms')} | ${measurement(run.timings.triggersReportedMs, 'ms')} | ${measurement(run.timings.cfDeployWallMs, 'ms')} | ${measurement(run.bundle?.rawBytes, 'bytes', 0)} / ${measurement(run.bundle?.gzipBytes, 'bytes', 0)} | ${escape(run.versionId)} |`;
  })
  .join('\n')}

`
    : `
#### Other deployment timings

| Phase | Value |
| --- | --- |
${(['triggersReportedMs', 'cleanWallMs', 'workerLookupWallMs'] as const).map((key) => `| ${labels[key]} | ${measurement(deploy.timings?.[key], 'ms')} |`).join('\n')}

One deployment was recorded; no repeated-run confidence intervals are available.

Worker startup is a separate runtime initialization metric, not end-to-end cold-request latency. Deploy command total includes build and excludes subsequent Worker lookup and Access setup.

`;
  const title = `# ${escape(result.benchmark)} benchmark report

Successful run: **${escape(result.finishedAt)}**

Source measurements: [report.json](report.json).
`;
  const context = `## Context
 
${table([
  ['Run started (UTC)', result.startedAt],
  ['Run finished (UTC)', result.finishedAt],
  ['Platform', machine?.platform],
  ['OS release', result.runtime.osRelease],
  ['Node.js', result.runtime.node],
  ['oha', latency?.ohaVersion],
  ['CPU', machine?.cpu?.models?.join(', ')],
  ['Architecture', machine?.cpu?.architecture],
  [
    'Logical cores / available parallelism',
    `${number(machine?.cpu?.logicalCores)} / ${number(machine?.cpu?.availableParallelism)}`,
  ],
  [
    'Network type / interface',
    `${escape(machine?.network?.type)} / ${escape(machine?.network?.interface)}`,
  ],
  ['Hostname SHA-256', machine?.hostnameSha256],
])}

Network information describes the local default route, not a verified end-to-end path.

`;
  const workloadSettings =
    latency && metrics
      ? `
${table([
  ['URL', latency.url],
  ['Method', settings.request?.method ?? 'GET'],
  ['Expected status', settings.request?.status ?? 200],
  [
    'Expected body size per response',
    settings.request?.bodyBytes === undefined
      ? 'Not constrained'
      : measurement(settings.request.bodyBytes, 'bytes', 0),
  ],
  ['Measured requests per round', settings.requests ?? 'Duration-based'],
  ['Latency rounds', settings.runs ?? 1],
  [
    'Total measured requests',
    latencyStatistics?.requests ??
      Object.values(latency.oha.statusCodeDistribution).reduce((sum, count) => sum + count, 0),
  ],
  ['Duration limit per round', settings.duration ?? 'None'],
  ['Connections', settings.connections],
  ['Rate limit', settings.rate == null ? 'None' : measurement(settings.rate, 'req/s')],
  ['Request timeout', settings.timeout],
  ['HTTP version', settings.httpVersion],
  ['Keep-alive', settings.keepAlive],
  ['Warmup requests per round (excluded from client statistics)', settings.warmupRequests],
  ['Access authentication', settings.access],
  [
    'HTTP response counts',
    Object.entries(latency.oha.statusCodeDistribution)
      .map(([code, count]) => `${code}: ${number(count, 0)}`)
      .join(', '),
  ],
])}
`
      : '';
  const workload =
    latency && metrics
      ? `
## Client latency

| Measurement | Value |
| --- | --- |
| Mean | ${measurement(summary.average * 1000, 'ms')} |
| Minimum | ${measurement(summary.fastest * 1000, 'ms')} |
| P50 | ${measurement(latencyPercentiles.p50 * 1000, 'ms')} |
| P95 | ${measurement(latencyPercentiles.p95 * 1000, 'ms')} |
| P99 | ${measurement(latencyPercentiles.p99 * 1000, 'ms')} |
| Maximum | ${measurement(summary.slowest * 1000, 'ms')} |
| Throughput | ${measurement(summary.requestsPerSec, 'req/s')} |
| Measured duration | ${measurement(summary.total, 's')} |

### Details

<details>
<summary>Show details</summary>

#### Latency methodology

Client latency includes network and Access overhead. Throughput at the selected concurrency is not a capacity measurement.
${latencyConfidence}
${latencyStatistics ? 'Warmup runs precede each measured round in a separate oha process: they exercise the application but do not preserve the measured connection. Each measured round includes new-connection effects and keeps connections alive within that round. Warmup does not guarantee a warm isolate. Client statistics exclude warmup; measured duration is the sum of measured oha durations, excluding warmup and inter-round gaps.' : ''}

</details>

## Worker metrics

| Requests | Errors | Subrequests |
| --- | --- | --- |
| ${number(metrics.metrics.sum.requests, 0)} | ${number(metrics.metrics.sum.errors, 0)} | ${number(metrics.metrics.sum.subrequests, 0)} |

| Measurement | P50 | P90 | P99 | P99.9 |
| --- | --- | --- | --- | --- |
${metricRow('CPU', 'cpuTime', 'µs')}
${metricRow('Wall time', 'wallTime', 'µs')}
${metricRow('Isolate memory', 'memoryUsageBytes', 'MiB', 1024 ** 2)}

### Details

<details>
<summary>Show details</summary>

#### Analytics window

${table([
  ['Measurement start (UTC)', metrics.window.requested.start],
  ['Measurement end (UTC)', metrics.window.requested.end],
  ['Query start, inclusive (UTC)', metrics.window.queried.start],
  ['Query end, inclusive (UTC)', metrics.window.queried.end],
  ['Padding per side', measurement(result.settings.metricsPaddingMs / 1000, 's')],
  ['Ingestion wait after query end', measurement(result.settings.metricsWaitMs / 1000, 's')],
  ['Retry interval', measurement(result.settings.metricsIntervalMs / 1000, 's')],
  ['Quiet-window checks / result queries', `${result.quietAttempts} / ${result.metricsAttempts}`],
])}

#### Worker metrics methodology

CPU is time actively executing code, excluding time waiting on I/O. Wall time is the lifetime of the invocation's JavaScript context, including I/O waits and \`waitUntil()\` work; it is not client response latency. Memory is shared isolate usage at invocation time, not per-request allocation or peak memory. An isolate can serve concurrent requests.

CPU and wall-time quantiles are returned in microseconds; memory is returned in bytes and displayed in MiB (1 MiB = 1,048,576 bytes). These percentiles use reservoir sampling. P50 is the median; P90, P99, and P99.9 describe the corresponding upper percentiles.

Sources: [Cloudflare metric definitions](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/), [CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), and [GraphQL field descriptions (public schema mirror)](https://pages.johnspurlock.com/graphql-schema-docs/cloudflare.html#AccountWorkersInvocationsAdaptiveQuantiles).

Analytics are aggregated/sampled across the whole Worker and padded window, not filtered by route or version. An empty preflight check is best-effort: ingestion delays can hide recent traffic. Avoid unrelated traffic; counts need not match oha exactly.
${latencyStatistics ? 'The analytics window spans all latency rounds, including warmup requests and inter-round gaps. Worker CPU/wall-time/memory percentiles therefore include warmup traffic and have no round-bootstrap confidence intervals.' : ''}

</details>
`
      : '';
  const deploymentMetadata = `
#### Deployment details

${table([
  ['Worker', deploy.workerName],
  ['Worker ID', deploy.workerId],
  ['Version ID', deploy.versionId],
  ['Origin', deploy.url],
  [
    'Final run Access setup/check (excluded from command timing)',
    measurement(deploy.timings?.accessWallMs, 'ms'),
  ],
  [
    'Final run workflow wall time (includes cleanup, lookup, Access)',
    measurement(deploy.timings?.workflowWallMs, 'ms'),
  ],
])}

The final run's version is used for the latency measurement. Access is configured/checked only after the final deployment.

CLI-reported build/upload/activation timings and locally measured command wall time overlap: do not add them together or infer unmeasured overhead by subtraction. App build outputs were cleaned before every run; workspace builds, OS caches, and remote upload deduplication were preserved. Node compile caching was disabled. No cold-start guarantee is implied.

`;
  const deployment = `
## Build & deployment

### Bundle size

| Format | Size (Median) |
| --- | --- |
| Raw | ${measurement(bundleMedian('rawBytes'), 'bytes', 1)} |
| Gzip | ${measurement(bundleMedian('gzipBytes'), 'bytes', 1)} |

${deploymentTimingSummary}

### Details

<details>
<summary>Show details</summary>

${deploymentMetadata}

#### Bundle-size context

Medians use successful deployments with recorded sizes.

| Format | Final deployment | Batch range |
| --- | --- | --- |
| Raw | ${measurement(deploy.bundle?.rawBytes, 'bytes', 0)} | ${range(batch?.bundle.rawBytes?.min, batch?.bundle.rawBytes?.max, 'bytes', 0)} |
| Gzip | ${measurement(deploy.bundle?.gzipBytes, 'bytes', 0)} | ${range(batch?.bundle.gzipBytes?.min, batch?.bundle.gzipBytes?.max, 'bytes', 0)} |

${batch ? `Bundle-size variation: ${Object.values(batch.bundle).some((range) => range.min !== range.max) ? 'Changed across runs; inspect individual measurements.' : 'None observed.'}` : 'Batch ranges are unavailable for historical single-deployment results.'}

${deploymentTimingDetails}

</details>
`;
  return { title, context, settings: workloadSettings, workload, deployment };
}

export function regenerateReport(
  app: string,
  input = fs.existsSync(path.join(app, 'report.json'))
    ? path.join(app, 'report.json')
    : path.join(app, 'artifacts/benchmark/stats.json'),
) {
  if (fs.existsSync(path.join(app, 'artifacts/benchmark/.benchmark.lock'))) {
    throw new Error('A benchmark flow is running; wait before regenerating its report.');
  }
  const saved = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (
    saved.kind !== undefined &&
    (saved.kind !== 'void-benchmark-report' || saved.schemaVersion !== 1)
  ) {
    throw new Error('Unsupported report snapshot format.');
  }
  const completeLatency = (
    latency: Record<string, unknown> | undefined,
    metrics: Record<string, unknown> | undefined,
  ) =>
    latency?.status === 'success' &&
    latency.oha &&
    metrics?.status === 'success' &&
    metrics.metrics;
  if (
    saved.status !== 'success' ||
    saved.benchmark !== path.basename(app) ||
    saved.deploy?.status !== 'success' ||
    !saved.finishedAt ||
    (saved.latencyWorkloads === undefined
      ? !completeLatency(saved.latency, saved.metrics)
      : !Array.isArray(saved.latencyWorkloads) ||
        saved.latencyWorkloads.some(
          (workload: {
            status?: string;
            latency?: Record<string, unknown>;
            metrics?: Record<string, unknown>;
          }) =>
            workload.status !== 'success' || !completeLatency(workload.latency, workload.metrics),
        ))
  ) {
    throw new Error('Expected successful combined benchmark artifacts for this app.');
  }
  const result: Result = {
    ...saved,
    quietAttempts: saved.quietAttempts ?? saved.metricsQuietAttempts?.length ?? 0,
    metricsAttempts:
      typeof saved.metricsAttempts === 'number'
        ? saved.metricsAttempts
        : (saved.metricsAttempts?.length ?? 0),
  };
  return writeBenchmarkReport(app, result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        input: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log(
        'Usage: vp run report <benchmark-id> [--input <report.json|combined-stats.json>]',
      );
    } else {
      if (positionals.length !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(positionals[0])) {
        throw new Error(
          'Usage: vp run report <benchmark-id> [--input <report.json|combined-stats.json>]',
        );
      }
      const app = fileURLToPath(new URL(`../${positionals[0]}/`, import.meta.url)).replace(
        /\/$/,
        '',
      );
      if (!fs.existsSync(path.join(app, 'cloudflare.config.ts')) || fs.realpathSync(app) !== app) {
        throw new Error('Not a benchmark app.');
      }
      console.log(
        regenerateReport(app, values.input === undefined ? undefined : path.resolve(values.input)),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
