import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path/posix';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadBenchmarkConfig, resolveBenchmarkConfig } from './config.ts';
import { parseLatencyArgs } from './latency.ts';
import { metricsWindow, parseMetricsDuration } from './metrics.ts';
import { writeBenchmarkReport } from './report.ts';
import { parseRunCount } from './statistics.ts';

const benchmarkRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage: node benchmark/scripts/benchmark.ts <benchmark-id> [options]

Deploy batch → wait for quiet metrics → employee Access login → oha latency → wait for metrics → report.md + report.json.

  --path <path>            Override JSON with one app-relative workload
  -n, --requests <n>        Measured requests per latency round (default: 500)
  --latency-runs <n>       Latency rounds (default: 10)
  --warmup-requests <n>    Unmeasured requests before each round (default: 50)
  -c, --connections <n>     Concurrent connections (default: 1)
  -z, --duration <time>     Duration per round instead of request count, e.g. 30s
  -q, --rate <qps>          Optional requests-per-second limit
  -t, --timeout <time>      Per-request timeout (default: 30s)
  --http-version <v>       1.1 (default) or 2
  --deploy-runs <n>        Clean build-and-deploy measurements (default: 30)
  --metrics-attempts <n>    Maximum queries per quiet/results phase (default: 61)
  --metrics-interval <time> Delay between queries (default: 10s)
  --metrics-padding <time> Pad each side; quiet lookback is twice this (default: 90s)
  --metrics-wait <time>    Ingestion wait after the padded window ends (default: 3m)
  -h, --help               Show usage

Loads <benchmark-id>/benchmark.jsonc; omitted fields use defaults.
CLI latency settings override each JSON workload; --path selects one ad-hoc workload.
Use "latency": [] for deployment only. Regenerate reports with vp run report <benchmark-id>.

Requires built workspace packages, cf and oha on PATH, CLOUDFLARE_ACCOUNT_ID,
and CLOUDFLARE_API_TOKEN with deploy, Access Edit, and Account Analytics Read.
CF_ACCESS_TOKEN skips browser login. No workspace package rebuild is performed.`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);

  try {
    const options = parseBenchmarkArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
    } else {
      await benchmark(options);
    }
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

export function parseBenchmarkArgs(args: Array<string>) {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      path: { type: 'string' },
      requests: { type: 'string', short: 'n' },
      'latency-runs': { type: 'string' },
      'warmup-requests': { type: 'string' },
      connections: { type: 'string', short: 'c' },
      duration: { type: 'string', short: 'z' },
      rate: { type: 'string', short: 'q' },
      timeout: { type: 'string', short: 't' },
      'http-version': { type: 'string' },
      'deploy-runs': { type: 'string' },
      'metrics-attempts': { type: 'string', default: '61' },
      'metrics-interval': { type: 'string', default: '10s' },
      'metrics-padding': { type: 'string', default: '90s' },
      'metrics-wait': { type: 'string', default: '3m' },
    },
  });
  if (values.help) {
    return { help: true } as const;
  }
  if (positionals.length !== 1) {
    throw new Error(usage);
  }
  const latencyArgs = Object.entries(values).flatMap(([key, value]) =>
    key !== 'help' && key !== 'deploy-runs' && !key.startsWith('metrics-') && value !== undefined
      ? [`--${key}`, String(value)]
      : [],
  );
  const latency = parseLatencyArgs([positionals[0], ...latencyArgs]);
  if (latency.help) {
    throw new Error(usage);
  }
  const attempts = Number(values['metrics-attempts']);
  if (
    !/^\d+$/.test(values['metrics-attempts']) ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1
  ) {
    throw new Error('--metrics-attempts must be a positive safe integer.');
  }
  return {
    help: false,
    benchmark: latency.benchmark,
    latencyArgs,
    deployRuns:
      values['deploy-runs'] === undefined
        ? undefined
        : parseRunCount(values['deploy-runs'], '--deploy-runs'),
    metricsAttempts: attempts,
    metricsIntervalMs: parseMetricsDuration(values['metrics-interval'], '--metrics-interval'),
    metricsPaddingMs: parseMetricsDuration(values['metrics-padding'], '--metrics-padding'),
    metricsWaitMs: parseMetricsDuration(values['metrics-wait'], '--metrics-wait'),
  } as const;
}

async function benchmark(options: Exclude<ReturnType<typeof parseBenchmarkArgs>, { help: true }>) {
  const app = path.join(benchmarkRoot, options.benchmark);
  if (!fs.existsSync(path.join(app, 'cloudflare.config.ts')) || fs.realpathSync(app) !== app) {
    throw new Error(`Not a benchmark app: ${options.benchmark}`);
  }
  const configuration = loadBenchmarkConfig(app);
  const resolved = resolveBenchmarkConfig(options.benchmark, configuration, options);
  if (
    !/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '') ||
    !process.env.CLOUDFLARE_API_TOKEN?.trim()
  ) {
    throw new Error(
      'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN before running the benchmark.',
    );
  }
  const artifacts = path.join(app, 'artifacts/benchmark');
  checkLocalPath(app, artifacts);
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const lock = path.join(artifacts, '.benchmark.lock');
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`A benchmark flow is already running (or left a stale lock): ${lock}`);
    }
    throw error;
  }

  const controller = new AbortController();
  let child: ChildProcess | undefined;
  const onSignal = () => {
    controller.abort(new Error('Benchmark interrupted.'));
    // Each step owns its detached command groups and credential cleanup.
    child?.kill('SIGTERM');
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const stats: Record<string, unknown> = {
    schemaVersion: 2,
    benchmark: options.benchmark,
    status: 'failed',
    stage: 'preflight',
    startedAt: new Date().toISOString(),
    runtime: { node: process.version, osRelease: os.release() },
    settings: {
      latencyArgs: options.latencyArgs,
      deployRuns: resolved.deployRuns,
      metricsAttempts: options.metricsAttempts,
      metricsIntervalMs: options.metricsIntervalMs,
      metricsPaddingMs: options.metricsPaddingMs,
      metricsWaitMs: options.metricsWaitMs,
    },
    metricsQuietAttempts: [],
    metricsAttempts: [],
    configuration,
    resolvedConfiguration: resolved,
    latencyWorkloads: [],
  };
  let activeWorkload: Record<string, unknown> | undefined;
  let directory: string | undefined;

  async function command(file: string, args: Array<string>) {
    controller.signal.throwIfAborted();
    let stdout = '';
    let failure: Error | undefined;
    const code = await new Promise<number | null>((resolve) => {
      child = spawn(file, args, {
        cwd: benchmarkRoot,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', (chunk) => (stdout += chunk.toString()));
      // Keep browser instructions visible without copying authentication output to artifacts.
      child.stderr!.on('data', (chunk) => process.stderr.write(chunk));
      child.on('error', (error) => (failure = error));
      child.on('close', (code) => {
        child = undefined;
        resolve(code);
      });
    });
    if (failure) {
      throw new Error(
        `Could not start ${path.basename(file)}; install it and ensure it is on PATH.`,
      );
    }
    return { code, stdout: redact(stdout) };
  }

  async function step(
    name: 'deploy' | 'latency' | 'metrics',
    args: Array<string> = [],
    quiet = false,
  ) {
    stats.stage = quiet ? 'metrics-quiet' : name;
    process.stderr.write(`Benchmark ${options.benchmark}: ${stats.stage}\n`);
    const result = await command(process.execPath, [
      path.join(benchmarkRoot, 'scripts', `${name}.ts`),
      options.benchmark,
      ...args,
    ]);
    let record;
    try {
      record = JSON.parse(result.stdout);
    } catch {
      controller.signal.throwIfAborted();
      throw new Error(`${name} did not return benchmark stats; see the errors above.`);
    }
    if (
      record?.benchmark !== options.benchmark ||
      !['success', 'failed'].includes(record.status) ||
      typeof record.artifacts !== 'string' ||
      path.dirname(record.artifacts) !== path.join(app, 'artifacts', name)
    ) {
      throw new Error(`${name} returned invalid benchmark stats.`);
    }
    if (!quiet) {
      stats[name] = record;
      if (activeWorkload && name !== 'deploy') {
        activeWorkload[name] = record;
      }
    }
    if (name === 'metrics') {
      (stats[quiet ? 'metricsQuietAttempts' : 'metricsAttempts'] as Array<unknown>).push(record);
      if (activeWorkload) {
        (activeWorkload[quiet ? 'metricsQuietAttempts' : 'metricsAttempts'] as Array<unknown>).push(
          record,
        );
      }
    }
    controller.signal.throwIfAborted();
    if (result.code !== 0 || record.status !== 'success') {
      if (
        name === 'metrics' &&
        record.status === 'failed' &&
        result.code !== 0 &&
        record.errorCode === 'NO_DATA'
      ) {
        return record;
      }
      throw new Error(`${name} failed: ${record.error ?? 'see step artifacts'}`);
    }
    return record;
  }

  try {
    directory = fs.mkdtempSync(
      path.join(artifacts, `${String(stats.startedAt).replace(/[:.]/g, '-')}-`),
    );
    stats.artifacts = directory;
    process.stderr.write(`Benchmark flow artifacts: ${directory}\n`);
    if (resolved.workloads.length) {
      const oha = await command('oha', ['--version']);
      controller.signal.throwIfAborted();
      if (oha.code !== 0) {
        throw new Error('oha --version failed; no deployment was started.');
      }
    }
    const deployment = await step('deploy', ['--benchmark', '--runs', String(resolved.deployRuns)]);
    if (
      !deployment.workerId ||
      !deployment.versionId ||
      !deployment.workerName ||
      !deployment.url ||
      deployment.batch?.requestedRuns !== resolved.deployRuns ||
      deployment.batch?.completedRuns !== resolved.deployRuns ||
      deployment.batch?.failedRuns !== 0 ||
      deployment.batch?.runs?.at(-1)?.versionId !== deployment.versionId
    ) {
      throw new Error('deploy returned incomplete deployment stats.');
    }
    stats.machine = deployment.machine;
    function validateMetrics(
      metrics: Awaited<ReturnType<typeof step>>,
      window: ReturnType<typeof metricsWindow>,
      latencyFile: string | null,
    ) {
      if (
        metrics.latencyFile !== latencyFile ||
        metrics.deployment?.workerId !== deployment.workerId ||
        metrics.deployment?.versionId !== deployment.versionId ||
        metrics.workerName !== deployment.workerName ||
        metrics.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID ||
        metrics.window?.requested?.start !== window.requested.start ||
        metrics.window?.requested?.end !== window.requested.end ||
        metrics.window?.queried?.start !== window.queried.start ||
        metrics.window?.queried?.end !== window.queried.end
      ) {
        throw new Error('Metrics do not match this deployment and latency window.');
      }
    }
    for (const workload of resolved.workloads) {
      activeWorkload = {
        id: workload.id,
        description: workload.description,
        request: workload.request,
        expect: workload.expect,
        effectiveSettings: workload.effectiveSettings,
        status: 'failed',
        metricsQuietAttempts: [],
        metricsAttempts: [],
      };
      (stats.latencyWorkloads as Array<unknown>).push(activeWorkload);
      process.stderr.write(`Workload: ${workload.id} — ${workload.description}\n`);
      process.stderr.write(
        `Checking for an empty ${(2 * options.metricsPaddingMs) / 1000}s Worker metrics window before load.\n`,
      );
      for (let attempt = 1; attempt <= options.metricsAttempts; attempt++) {
        const end = Date.now();
        const window = metricsWindow(
          new Date(end - 2 * options.metricsPaddingMs).toISOString(),
          new Date(end).toISOString(),
        );
        const metrics = await step(
          'metrics',
          ['--start', window.requested.start, '--end', window.requested.end],
          true,
        );
        validateMetrics(metrics, window, null);
        if (metrics.errorCode === 'NO_DATA') {
          process.stderr.write('Worker metrics window is empty; starting latency.\n');
          break;
        }
        if (attempt === options.metricsAttempts) {
          throw new Error(
            'Worker metrics are still busy; no benchmark load was sent. Try again later.',
          );
        }
        process.stderr.write(
          `Worker metrics are not empty; rechecking in ${options.metricsIntervalMs}ms.\n`,
        );
        await setTimeout(options.metricsIntervalMs, undefined, { signal: controller.signal });
      }
      const latency = await step('latency', workload.args);
      if (
        !deployment.workerId ||
        !deployment.versionId ||
        latency.deployment?.workerId !== deployment.workerId ||
        latency.deployment?.versionId !== deployment.versionId ||
        new URL(latency.url).href !== new URL(workload.effectiveSettings.path, deployment.url).href
      ) {
        throw new Error(
          'Deployment changed during the benchmark; do not run standalone steps concurrently.',
        );
      }
      const latencyFile = path.join(latency.artifacts, 'stats.json');
      const window = metricsWindow(
        latency.measurementStartedAt,
        latency.measurementFinishedAt,
        options.metricsPaddingMs,
      );
      stats.stage = 'metrics-wait';
      // Split long waits so the sum of padding and ingestion delay never overflows a Node timer.
      for (const deadline of [
        Date.parse(window.queried.end),
        Date.parse(window.queried.end) + options.metricsWaitMs,
      ]) {
        for (let remaining = deadline - Date.now(); remaining > 0;) {
          const delay = Math.min(remaining, 2_147_483_647);
          process.stderr.write(`Waiting ${delay}ms for the metrics window and ingestion.\n`);
          await setTimeout(delay, undefined, { signal: controller.signal });
          remaining -= delay;
        }
      }
      for (let attempt = 1; attempt <= options.metricsAttempts; attempt++) {
        const metrics = await step('metrics', [
          '--latency',
          latencyFile,
          '--padding',
          `${options.metricsPaddingMs}ms`,
        ]);
        validateMetrics(metrics, window, latencyFile);
        if (metrics.status === 'success') {
          activeWorkload.status = 'success';
          break;
        }
        if (attempt === options.metricsAttempts) {
          throw new Error(
            `Metrics are still unavailable; retry metrics with --latency ${latencyFile} --padding ${options.metricsPaddingMs}ms. No redeployment or load rerun is needed.`,
          );
        }
        process.stderr.write(`No metrics data yet; retrying in ${options.metricsIntervalMs}ms.\n`);
        await setTimeout(options.metricsIntervalMs, undefined, { signal: controller.signal });
      }
    }
    activeWorkload = undefined;
    stats.status = 'success';
    checkLocalPath(app, path.join(artifacts, 'stats.json'));
    stats.stage = 'report';
    const reportFile = path.join(app, 'report.md');
    checkLocalPath(app, reportFile);
    checkLocalPath(app, path.join(app, 'report.json'));
    stats.finishedAt = new Date().toISOString();
    writeBenchmarkReport(app, {
      benchmark: options.benchmark,
      startedAt: String(stats.startedAt),
      finishedAt: String(stats.finishedAt),
      runtime: { node: process.version, osRelease: os.release() },
      machine: stats.machine as Parameters<typeof writeBenchmarkReport>[1]['machine'],
      deploy: deployment,
      latencyWorkloads: stats.latencyWorkloads as Parameters<
        typeof writeBenchmarkReport
      >[1]['latencyWorkloads'],
      settings: options,
      quietAttempts: (stats.metricsQuietAttempts as Array<unknown>).length,
      metricsAttempts: (stats.metricsAttempts as Array<unknown>).length,
    });
    stats.reportFile = reportFile;
    stats.reportDataFile = path.join(app, 'report.json');
    process.stderr.write(`Benchmark report: ${reportFile}\n`);
    stats.stage = 'complete';
  } catch (error) {
    stats.status = 'failed';
    stats.error = controller.signal.aborted
      ? 'Benchmark interrupted.'
      : redact(error instanceof Error ? error.message : String(error));
    if (activeWorkload) {
      activeWorkload.error = stats.error;
    }
    throw new Error(stats.error as string);
  } finally {
    stats.finishedAt ??= new Date().toISOString();
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
  for (const token of [process.env.CLOUDFLARE_API_TOKEN, process.env.CF_ACCESS_TOKEN]) {
    if (token) {
      value = value.replaceAll(token, '[REDACTED]');
    }
  }
  return value;
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
