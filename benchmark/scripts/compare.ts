import fs from 'node:fs';
import path from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { createReportSnapshot } from './report.ts';
import { quantile } from './statistics.ts';

type Snapshot = ReturnType<typeof createReportSnapshot>;
type Source = { id: string; snapshot: Snapshot };
type Row = { label: string; values: Array<number | undefined> };
type Metric = { name: string; unit: string };

const benchmarkRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage: vp run --filter ./benchmark compare

Read benchmark/*/report.json and write benchmark/report.md with Mermaid comparisons.
No deployment, benchmark traffic, credentials, or Cloudflare queries are required.

  -h, --help  Show usage`;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSnapshot(value: unknown, id: string): asserts value is Snapshot {
  const invalid = () => new Error(`Invalid or unsupported report snapshot: ${id}/report.json`);
  if (
    !object(value) ||
    value.kind !== 'void-benchmark-report' ||
    value.schemaVersion !== 1 ||
    value.status !== 'success' ||
    value.benchmark !== id ||
    typeof value.finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.finishedAt)) ||
    !object(value.deploy) ||
    value.deploy.status !== 'success'
  ) {
    throw invalid();
  }
  const batch = value.deploy.batch;
  if (
    batch !== undefined &&
    (!object(batch) ||
      !Array.isArray(batch.runs) ||
      !object(batch.statistics) ||
      batch.runs.some((run) => !object(run) || !['success', 'failed'].includes(String(run.status))))
  ) {
    throw invalid();
  }
  const complete = (latency: unknown, metrics: unknown) => {
    if (
      !(
        object(latency) &&
        latency.status === 'success' &&
        object(latency.settings) &&
        typeof latency.url === 'string' &&
        object(latency.oha) &&
        object(latency.oha.summary) &&
        object(latency.oha.latencyPercentiles) &&
        object(metrics) &&
        metrics.status === 'success' &&
        object(metrics.metrics) &&
        object(metrics.metrics.quantiles)
      )
    ) {
      return false;
    }
    const units = metrics.units;
    if (
      !object(units) ||
      Object.entries({
        cpuTime: 'microseconds',
        wallTime: 'microseconds',
        memoryUsageBytes: 'bytes',
      }).some(([key, unit]) => units[key] != null && units[key] !== unit)
    ) {
      return false;
    }
    try {
      return ['https:', 'http:'].includes(new URL(latency.url as string).protocol);
    } catch {
      return false;
    }
  };
  if (value.latencyWorkloads === undefined) {
    if (!complete(value.latency, value.metrics)) {
      throw invalid();
    }
  } else {
    if (!Array.isArray(value.latencyWorkloads)) {
      throw invalid();
    }
    const ids = new Set<string>();
    for (const workload of value.latencyWorkloads) {
      if (
        !object(workload) ||
        typeof workload.id !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workload.id) ||
        ids.has(workload.id) ||
        workload.status !== 'success' ||
        !complete(workload.latency, workload.metrics)
      ) {
        throw invalid();
      }
      ids.add(workload.id);
    }
  }
}

function number(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Report measurements must be finite nonnegative numbers or unavailable.');
  }
  return value;
}

function scaled(value: unknown, factor: number) {
  const result = number(value);
  return result === undefined ? undefined : number(result * factor);
}

function cell(value: unknown) {
  return String(value ?? 'Unavailable')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('`', '&#96;')
    .replace(/[\r\n]/g, ' ');
}

function measurement(value: number | undefined, unit = '') {
  return value === undefined
    ? 'Unavailable'
    : `${value.toLocaleString('en-US', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`;
}

function table(headers: Array<string>, rows: Array<Array<string>>) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function chart(metric: Metric, rows: Array<Row>, index: number) {
  // Mermaid has no null bar representation: exclude missing points from the chart,
  // but retain them explicitly as Unavailable in the accompanying table.
  const points = rows.flatMap((row) =>
    row.values[index] === undefined ? [] : [{ label: row.label, value: row.values[index]! }],
  );
  if (!points.length) {
    return `### ${metric.name}\n\nNo recorded measurements.\n`;
  }
  const max = Math.max(...points.map((point) => point.value));
  const upper = max === 0 ? 1 : Math.min(Number.MAX_VALUE, max * 1.1);
  const height = Math.max(260, points.length * 42 + 100);
  const labels = points.map((point) => JSON.stringify(point.label)).join(', ');
  // Plain decimal notation is accepted by Mermaid even for very small values.
  const decimal = (value: number) =>
    value.toLocaleString('en-US', {
      useGrouping: false,
      maximumSignificantDigits: 8,
    });
  return `### ${metric.name}

\`\`\`mermaid
---
config:
  xyChart:
    width: 1100
    height: ${height}
---
xychart-beta horizontal
    x-axis [${labels}]
    y-axis "${metric.unit}" 0 --> ${decimal(upper)}
    bar [${points.map((point) => decimal(point.value)).join(', ')}]
\`\`\`
`;
}

function section(
  title: string,
  metrics: Array<Metric>,
  rows: Array<Row>,
  methodology: string,
  extra = '',
) {
  if (!rows.length) {
    return `## ${title}\n\nNo recorded workloads.\n`;
  }
  return `## ${title}

${metrics.map((metric, index) => chart(metric, rows, index)).join('\n')}
### Details

<details>
<summary>Show details</summary>

#### Values

${table(
  ['Benchmark / workload', ...metrics.map((metric) => metric.name)],
  rows.map((row) => [
    cell(row.label),
    ...metrics.map((metric, index) => measurement(row.values[index], metric.unit)),
  ]),
)}

#### Methodology

${methodology}
${extra}
</details>
`;
}

export function renderComparison(sources: Array<Source>) {
  const bundleMetrics = [
    { name: 'Raw', unit: 'KB' },
    { name: 'Gzip', unit: 'KB' },
  ];
  const timingMetrics = [
    { name: 'Build', key: 'buildReportedMs', unit: 'ms' },
    { name: 'Upload', key: 'uploadReportedMs', unit: 'ms' },
    { name: 'Worker startup', key: 'workerStartupMs', unit: 'ms' },
    { name: '`cf deploy`', key: 'cfDeployWallMs', unit: 'ms' },
  ];
  const latencyMetrics = [
    { name: 'Mean', key: 'average', unit: 'ms' },
    { name: 'Minimum', key: 'fastest', unit: 'ms' },
    { name: 'P50', key: 'p50', unit: 'ms' },
    { name: 'P95', key: 'p95', unit: 'ms' },
    { name: 'P99', key: 'p99', unit: 'ms' },
    { name: 'Maximum', key: 'slowest', unit: 'ms' },
    { name: 'Throughput', key: 'requestsPerSec', unit: 'req/s' },
  ];
  const workerMetrics = [
    { name: 'CPU', key: 'cpuTime', unit: 'µs', factor: 1 },
    { name: 'Wall time', key: 'wallTime', unit: 'µs', factor: 1 },
    { name: 'Isolate memory', key: 'memoryUsageBytes', unit: 'MiB', factor: 1 / 1024 ** 2 },
  ];
  const bundles = sources.map(({ id, snapshot }) => ({
    label: id,
    values: ['rawBytes', 'gzipBytes'].map((key) => {
      const deploy = snapshot.deploy;
      if (!deploy.batch) {
        return scaled(deploy.bundle?.[key as 'rawBytes' | 'gzipBytes'], 1 / 1000);
      }
      const sizes = deploy.batch.runs
        .filter((run) => run.status === 'success')
        .map((run) => number(run.bundle?.[key as 'rawBytes' | 'gzipBytes']))
        .filter((value): value is number => value !== undefined)
        .sort((a, b) => a - b);
      return sizes.length ? quantile(sizes, 0.5) / 1000 : undefined;
    }),
  }));
  const timings = sources.map(({ id, snapshot }) => ({
    label: id,
    values: timingMetrics.map((metric) =>
      snapshot.deploy.batch
        ? number(snapshot.deploy.batch.statistics[metric.key]?.mean)
        : number(
            snapshot.deploy.timings?.[
              metric.key as keyof NonNullable<Snapshot['deploy']['timings']>
            ],
          ),
    ),
  }));
  const workloads = sources.flatMap(({ id, snapshot }) =>
    (
      snapshot.latencyWorkloads ??
      (snapshot.latency && snapshot.metrics
        ? [{ id: 'latency', latency: snapshot.latency, metrics: snapshot.metrics }]
        : [])
    ).map((workload) => ({ ...workload, label: `${id} / ${workload.id}` })),
  );
  const latency = workloads.map((workload) => ({
    label: workload.label,
    values: latencyMetrics.map((metric) =>
      scaled(
        (['p50', 'p95', 'p99'].includes(metric.key)
          ? workload.latency.oha.latencyPercentiles
          : workload.latency.oha.summary
        )[metric.key],
        metric.unit === 'ms' ? 1000 : 1,
      ),
    ),
  }));
  const workerRows = (percentile: string) =>
    workloads.map((workload) => ({
      label: workload.label,
      values: workerMetrics.map((metric) =>
        scaled(workload.metrics.metrics.quantiles[metric.key + percentile], metric.factor),
      ),
    }));
  const workloadContext = table(
    [
      'Benchmark / workload',
      'Request',
      'Rounds',
      'Requests / duration per round',
      'Connections',
      'Rate limit',
    ],
    workloads.map((workload) => {
      const url = new URL(workload.latency.url);
      const settings = workload.latency.settings;
      return [
        cell(workload.label),
        cell(`${settings.request?.method ?? 'GET'} ${url.pathname}${url.search}`),
        measurement(number(settings.runs)),
        settings.duration ? cell(settings.duration) : measurement(number(settings.requests)),
        measurement(number(settings.connections)),
        settings.rate == null ? 'None' : measurement(number(settings.rate), 'req/s'),
      ];
    }),
  );
  const otherPercentiles = ['P90', 'P99', 'P999']
    .map((percentile) => {
      const display = percentile === 'P999' ? 'P99.9' : percentile;
      const rows = workerRows(percentile);
      return `\n#### ${display}\n\n${workerMetrics
        .map((metric, index) => chart(metric, rows, index).replace(/^### /gm, '##### '))
        .join('\n')}
${table(
  ['Benchmark / workload', ...workerMetrics.map((metric) => metric.name)],
  rows.map((row) => [
    cell(row.label),
    ...workerMetrics.map((metric, index) => measurement(row.values[index], metric.unit)),
  ]),
)}\n`;
    })
    .join('');
  return `# Workers benchmark comparison

Overview of the latest saved benchmark reports. Lower is better except throughput, where higher is better.

## Benchmarks

${table(
  ['Benchmark', 'Measured (UTC)', 'Data'],
  sources.map(({ id, snapshot }) => [
    `[${id}](./${id}/report.md)`,
    cell(snapshot.finishedAt),
    `[report.json](./${id}/report.json)`,
  ]),
)}

${section('Bundle size', bundleMetrics, bundles, 'Median raw and gzip sizes across successful deployments with recorded sizes, in KB (1 KB = 1,000 bytes). Historical single-deployment reports use the recorded size.')}
${section('Deployment timing', timingMetrics, timings, 'Means across successful deployment runs; historical single-deployment reports use the recorded timing. These phases overlap: do not add them. `cf deploy` includes build but excludes later Worker lookup and Access setup. Worker startup is runtime initialization, not cold-request latency.')}
${section('Latency', latencyMetrics, latency, 'Client latency includes network and Access overhead. Values describe pooled requests where available; throughput at the recorded concurrency is not capacity. Different routes, payloads, connection counts, or request settings are not equivalent workloads.', `\n#### Workload context\n\n${workloadContext}\n`)}
${section('Worker metrics (P50)', workerMetrics, workerRows('P50'), 'CPU excludes time waiting on I/O. Wall time includes I/O waits and `waitUntil()` work, not client response time. Memory is shared isolate usage, not per-request allocation or peak memory. Quantiles are sampled across each Worker and its padded measurement window, including warmups. Raw CPU and wall-time quantiles are microseconds; memory bytes are converted to MiB.', otherPercentiles)}
## Details

<details>
<summary>Show details</summary>

### Comparison context

Reports may have been collected at different times, on different machines, or with different workloads and settings. Shared caches, network conditions, and Cloudflare load affect results. These charts are descriptive comparisons, not statistical significance tests or performance rankings.

Missing measurements are omitted from charts and shown as Unavailable in the value tables, never plotted as zero. See each linked report for confidence intervals, environment context, and full methodology. Deployment-only snapshots contribute only bundle sizes and deployment timings.

Regenerate from the repository root with \`vp run --filter ./benchmark compare\`. Only adjacent saved report snapshots are read; no private artifacts or live services are needed.

</details>
`;
}

export function generateComparison(root = benchmarkRoot) {
  const sources: Array<Source> = [];
  for (const entry of fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
      continue;
    }
    const file = path.join(root, entry.name, 'report.json');
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Expected a regular report snapshot: ${entry.name}/report.json`);
    }
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`Could not read JSON: ${entry.name}/report.json`);
    }
    validateSnapshot(snapshot, entry.name);
    sources.push({ id: entry.name, snapshot });
  }
  if (!sources.length) {
    throw new Error('No benchmark report.json snapshots found; generate individual reports first.');
  }
  const report = renderComparison(sources);
  const target = path.join(root, 'report.md');
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error('Expected a regular output file: report.md');
  }
  const temporary = fs.mkdtempSync(path.join(root, '.compare-'));
  try {
    const file = path.join(temporary, 'report.md');
    fs.writeFileSync(file, report, { mode: 0o600 });
    fs.renameSync(file, target);
  } finally {
    fs.rmSync(path.join(temporary, 'report.md'), { force: true });
    fs.rmdirSync(temporary);
  }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      strict: true,
      options: { help: { type: 'boolean', short: 'h' } },
    });
    console.log(values.help ? usage : generateComparison());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
