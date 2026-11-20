import fs from 'node:fs';
import path from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const benchmarkRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage: node benchmark/scripts/metrics.ts <benchmark-name> [options]

  --latency <file>       Saved latency stats (default: artifacts/latency/stats.json)
  --padding <time>       Pad each side of a latency window (default: 90s)
  --start <timestamp>    Explicit ISO timestamp with timezone; requires --end
  --end <timestamp>      End of explicit window; cannot combine with --latency
  --worker <name>        Override Worker name; requires an explicit time window
  -h, --help             Show usage

Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN with Account Analytics Read.
Queries GraphQL only; does not send benchmark requests or perform Access login.`;

export function parseMetricsArgs(args: Array<string>) {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      latency: { type: 'string' },
      padding: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      worker: { type: 'string' },
    },
  });
  if (values.help) {
    return { help: true } as const;
  }
  if (positionals.length !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(positionals[0])) {
    throw new Error(usage);
  }
  if (
    (values.start === undefined) !== (values.end === undefined) ||
    (values.latency !== undefined && values.start !== undefined) ||
    (values.worker !== undefined && values.start === undefined) ||
    (values.padding !== undefined && values.start !== undefined)
  ) {
    throw new Error(
      'Use --latency or both --start and --end; --worker requires an explicit window and --padding requires latency.',
    );
  }
  if (values.worker !== undefined && !/^[a-zA-Z0-9_-]{1,63}$/.test(values.worker)) {
    throw new Error('Invalid Worker name.');
  }
  return {
    help: false,
    benchmark: positionals[0],
    latency: values.latency,
    paddingMs: parseMetricsDuration(values.padding ?? '90s', '--padding'),
    window: values.start === undefined ? null : metricsWindow(values.start, values.end!),
    worker: values.worker,
  } as const;
}

export function parseMetricsDuration(value: string, flag: string) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value);
  const ms = match ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2]] ?? 0) : 0;
  if (!Number.isFinite(ms) || ms < 1 || ms > 2_147_483_647) {
    throw new Error(`${flag} must be a positive duration, e.g. 10s (maximum 24 days).`);
  }
  return ms;
}

export function metricsWindow(start: string, end: string, paddingMs = 0) {
  function timestamp(value: string) {
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw new Error('Expected ISO timestamps with an explicit timezone.');
    }
    return Date.parse(value);
  }
  const from = timestamp(start);
  const to = timestamp(end);
  if (from >= to) {
    throw new Error('The metrics start must precede the end.');
  }
  if (!Number.isFinite(paddingMs) || paddingMs < 0 || paddingMs > 2_147_483_647) {
    throw new Error('Invalid metrics padding.');
  }
  // Preserve measurement identity separately from the padded analytics boundaries.
  return {
    requested: { start: new Date(from).toISOString(), end: new Date(to).toISOString() },
    queried: {
      start: new Date(Math.floor((from - paddingMs) / 1000) * 1000).toISOString(),
      end: new Date(Math.ceil((to + paddingMs) / 1000) * 1000).toISOString(),
    },
  };
}

export const metricsQuery = `query BenchmarkMetrics($accountTag: string, $scriptName: string, $start: string, $end: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 1, filter: {
        scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end
      }) {
        sum { requests errors subrequests }
        quantiles {
          cpuTimeP50 cpuTimeP90 cpuTimeP99 cpuTimeP999
          wallTimeP50 wallTimeP90 wallTimeP99 wallTimeP999
          memoryUsageBytesP50 memoryUsageBytesP90 memoryUsageBytesP99 memoryUsageBytesP999
        }
      }
    }
  }
}`;

export class NoMetricsDataError extends Error {
  constructor() {
    super('No Worker metrics in this window yet; allow for ingestion delay and retry.');
  }
}

export async function queryMetrics(
  variables: { accountTag: string; scriptName: string; start: string; end: string },
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: metricsQuery, variables }),
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Cloudflare GraphQL HTTP ${response.status}; check token permissions and account scope.`,
    );
  }
  let data;
  try {
    data = JSON.parse((await response.text()).replaceAll(token, '[REDACTED]'));
  } catch {
    throw new Error('Cloudflare GraphQL returned invalid JSON.');
  }
  if (data.errors?.length) {
    throw new Error(`Cloudflare GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  const accounts = data.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error(
      'Expected one Cloudflare account; check Account Analytics Read and account scope.',
    );
  }
  const rows = accounts[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error('Expected an ungrouped Workers metrics response.');
  }
  if (rows.length === 0 || rows[0]?.sum?.requests === 0) {
    throw new NoMetricsDataError();
  }
  const row = rows[0];
  for (const field of ['requests', 'errors', 'subrequests']) {
    if (!Number.isFinite(row.sum?.[field]) || row.sum[field] < 0) {
      throw new Error(`Invalid Workers metrics sum: ${field}.`);
    }
  }
  for (const prefix of ['cpuTime', 'wallTime', 'memoryUsageBytes']) {
    for (const percentile of ['P50', 'P90', 'P99', 'P999']) {
      const value = row.quantiles?.[prefix + percentile];
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`Invalid Workers percentile: ${prefix}${percentile}.`);
      }
    }
  }
  return { metrics: row, response: data };
}

async function metrics(options: Exclude<ReturnType<typeof parseMetricsArgs>, { help: true }>) {
  const app = path.join(benchmarkRoot, options.benchmark);
  if (!fs.existsSync(path.join(app, 'cloudflare.config.ts')) || fs.realpathSync(app) !== app) {
    throw new Error(`Not a benchmark app: ${options.benchmark}`);
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/i.test(account) || !token?.trim()) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account Analytics Read).');
  }
  let deployment;
  if (!options.worker) {
    deployment = JSON.parse(fs.readFileSync(path.join(app, 'artifacts/deploy/stats.json'), 'utf8'));
    if (
      deployment.status !== 'success' ||
      deployment.benchmark !== options.benchmark ||
      typeof deployment.workerName !== 'string' ||
      !deployment.workerName
    ) {
      throw new Error('Expected successful deployment stats with a Worker name; deploy it first.');
    }
  }
  let window = options.window;
  let latencyFile;
  if (!window) {
    latencyFile = options.latency
      ? path.resolve(options.latency)
      : path.join(app, 'artifacts/latency/stats.json');
    const latency = JSON.parse(fs.readFileSync(latencyFile, 'utf8'));
    if (
      latency.status !== 'success' ||
      latency.benchmark !== options.benchmark ||
      !latency.deployment?.workerId ||
      latency.deployment.workerId !== deployment.workerId ||
      latency.deployment.versionId !== deployment.versionId ||
      typeof latency.measurementStartedAt !== 'string' ||
      typeof latency.measurementFinishedAt !== 'string'
    ) {
      throw new Error(
        'Expected successful latency stats for the saved deployment; use an explicit window otherwise.',
      );
    }
    window = metricsWindow(
      latency.measurementStartedAt,
      latency.measurementFinishedAt,
      options.paddingMs,
    );
  }
  const artifacts = path.join(app, 'artifacts/metrics');
  checkLocalPath(app, artifacts);
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const lock = path.join(artifacts, '.metrics.lock');
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`A metrics query is already running (or left a stale lock): ${lock}`);
    }
    throw error;
  }
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error('Metrics query interrupted.'));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const stats: Record<string, unknown> = {
    schemaVersion: 1,
    benchmark: options.benchmark,
    source: 'workersInvocationsAdaptive',
    accountId: account,
    workerName: options.worker ?? deployment.workerName,
    deployment: deployment
      ? { workerId: deployment.workerId, versionId: deployment.versionId }
      : null,
    latencyFile: latencyFile ?? null,
    window,
    // AccountWorkersInvocationsAdaptiveQuantiles field descriptions:
    // https://pages.johnspurlock.com/graphql-schema-docs/cloudflare.html#AccountWorkersInvocationsAdaptiveQuantiles
    units: { cpuTime: 'microseconds', wallTime: 'microseconds', memoryUsageBytes: 'bytes' },
    status: 'failed',
    startedAt: new Date().toISOString(),
  };
  let directory;
  try {
    directory = fs.mkdtempSync(
      path.join(artifacts, `${String(stats.startedAt).replace(/[:.]/g, '-')}-`),
    );
    stats.artifacts = directory;
    process.stderr.write(`Querying Cloudflare metrics; artifacts: ${directory}\n`);
    const variables = {
      accountTag: account,
      scriptName: stats.workerName as string,
      start: window.queried.start,
      end: window.queried.end,
    };
    writeJson(path.join(directory, 'query.json'), { query: metricsQuery, variables });
    const result = await queryMetrics(variables, token, fetch, controller.signal);
    stats.metrics = result.metrics;
    writeJson(path.join(directory, 'response.json'), result.response);
    // Check before marking success so a refused output path cannot promote a failed attempt.
    checkLocalPath(app, path.join(artifacts, 'stats.json'));
    stats.status = 'success';
  } catch (error) {
    if (error instanceof NoMetricsDataError) {
      stats.errorCode = 'NO_DATA';
    }
    stats.error = redact(error instanceof Error ? error.message : String(error));
    throw new Error(stats.error as string);
  } finally {
    stats.finishedAt = new Date().toISOString();
    try {
      if (directory) {
        writeJson(path.join(directory, 'stats.json'), stats);
        if (stats.status === 'success') {
          writeJson(path.join(artifacts, 'stats.json'), stats);
        }
        console.log(JSON.stringify(stats));
      }
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      fs.rmdirSync(lock);
    }
  }
}

function redact(value: string) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  return token ? value.replaceAll(token, '[REDACTED]') : value;
}

function writeJson(file: string, data: unknown) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function checkLocalPath(root: string, target: string) {
  let current = root;
  for (const part of path.relative(root, target).split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refusing to use a symlink: ${current}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);

  try {
    const options = parseMetricsArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
    } else {
      await metrics(options);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redact(message));
    process.exitCode = 1;
  }
}
