import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAccessToken } from './access-token.ts';
import { summarizeLatencyRounds } from './latency-statistics.ts';
import { getMachineInfo } from './machine.ts';
import { parseRunCount } from './statistics.ts';

const benchmarkRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage: node benchmark/scripts/latency.ts <benchmark-name> [options]

  --path <path>          App-relative request path and query (default: /)
  --request-json <json>  Request method/headers/body and expected status/bodyBytes
  -n, --requests <n>      Measured requests per round (default: 500)
  --latency-runs <n>     Measured rounds, 1–1000 (default: 10)
  --warmup-requests <n>  Unmeasured requests before each round (default: 50; 0 disables)
  -c, --connections <n>   Concurrent connections (default: 1)
  -z, --duration <time>   Duration per round instead of request count, e.g. 30s
  -q, --rate <qps>        Optional requests-per-second limit
  -t, --timeout <time>    Per-request timeout (default: 30s)
  --http-version <v>     1.1 (default) or 2; keep-alive enabled
  --url <origin>         Override saved deployment URL (no Access by default)
  --access               Authenticate an explicit --url through employee Access
  -h, --help             Show usage

Protected deployments use CF_ACCESS_TOKEN or a temporary cf access login.
Results contain oha client metrics only; no Cloudflare telemetry is fetched.`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);

  try {
    const options = parseLatencyArgs(process.argv.slice(2));

    if (options.help) {
      console.log(usage);
    } else {
      await latency(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function parseLatencyArgs(args: Array<string>) {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      path: { type: 'string' },
      'request-json': { type: 'string' },
      requests: { type: 'string', short: 'n' },
      'latency-runs': { type: 'string', default: '10' },
      'warmup-requests': { type: 'string', default: '50' },
      connections: { type: 'string', short: 'c', default: '1' },
      duration: { type: 'string', short: 'z' },
      rate: { type: 'string', short: 'q' },
      timeout: { type: 'string', short: 't', default: '30s' },
      'http-version': { type: 'string', default: '1.1' },
      url: { type: 'string' },
      access: { type: 'boolean' },
    },
  });

  if (values.help) {
    return { help: true } as const;
  }

  if (positionals.length !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(positionals[0])) {
    throw new Error(usage);
  }

  if (values.duration !== undefined && values.requests !== undefined) {
    throw new Error('Use --requests or --duration, not both.');
  }

  function integer(value: string, name: string) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
    return Number(value);
  }

  function duration(value: string, name: string) {
    if (
      !/^\d+(?:\.\d+)?(?:ms|s|m|h)$/.test(value) ||
      !Number.isFinite(Number.parseFloat(value)) ||
      Number.parseFloat(value) <= 0
    ) {
      throw new Error(`${name} must be a positive duration, e.g. 30s.`);
    }
    return value;
  }

  const configuredRequest =
    values['request-json'] === undefined ? undefined : JSON.parse(values['request-json']);
  const requestPath = values.path ?? configuredRequest?.request?.path ?? '/';
  if (typeof requestPath !== 'string') {
    throw new Error('Request path must be a string.');
  }
  const route = new URL(requestPath, 'https://benchmark.invalid');
  if (
    !requestPath.startsWith('/') ||
    requestPath.startsWith('//') ||
    requestPath.includes('\\') ||
    requestPath.includes('#') ||
    Array.from(requestPath).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    route.origin !== 'https://benchmark.invalid' ||
    route.hash ||
    route.username ||
    route.password
  ) {
    throw new Error('--path must be an app-relative path, optionally followed by a query string.');
  }

  if (!['1.1', '2'].includes(values['http-version'])) {
    throw new Error('--http-version must be 1.1 or 2.');
  }

  if (
    values.rate !== undefined &&
    (!/^\d+(?:\.\d+)?$/.test(values.rate) ||
      !Number.isFinite(Number(values.rate)) ||
      Number(values.rate) <= 0)
  ) {
    throw new Error('--rate must be a positive finite number.');
  }

  const warmupRequests = Number(values['warmup-requests']);
  if (
    !/^\d+$/.test(values['warmup-requests']) ||
    !Number.isSafeInteger(warmupRequests) ||
    warmupRequests < 0
  ) {
    throw new Error('--warmup-requests must be a nonnegative safe integer.');
  }
  const request = parseRequest(configuredRequest);
  return {
    help: false,
    benchmark: positionals[0],
    path: route.pathname + route.search,
    requests:
      values.duration === undefined ? integer(values.requests ?? '500', '--requests') : null,
    runs: parseRunCount(values['latency-runs'], '--latency-runs'),
    warmupRequests,
    connections: integer(values.connections, '--connections'),
    duration: values.duration === undefined ? null : duration(values.duration, '--duration'),
    rate: values.rate === undefined ? null : Number(values.rate),
    timeout: duration(values.timeout, '--timeout'),
    httpVersion: values['http-version'],
    origin: values.url === undefined ? null : origin(values.url),
    access: values.access ?? false,
    ...(request ? { request } : {}),
  } as const;
}

function parseRequest(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['request', 'expect'].includes(key))
  ) {
    throw new Error('Expected request and optional expect objects.');
  }
  const configured = value as Record<string, unknown>;
  const valueRequest = configured.request;
  const valueExpect = configured.expect === undefined ? {} : configured.expect;
  if (
    !valueRequest ||
    typeof valueRequest !== 'object' ||
    Array.isArray(valueRequest) ||
    Object.keys(valueRequest).some((key) => !['path', 'method', 'headers', 'body'].includes(key)) ||
    !valueExpect ||
    typeof valueExpect !== 'object' ||
    Array.isArray(valueExpect) ||
    Object.keys(valueExpect).some((key) => !['status', 'bodyBytes'].includes(key))
  ) {
    throw new Error('Invalid request or response expectation fields.');
  }
  const request = valueRequest as Record<string, unknown>;
  const expect = valueExpect as Record<string, unknown>;
  if (
    typeof request.path !== 'string' ||
    (request.method !== undefined &&
      (typeof request.method !== 'string' || !/^[A-Z]+$/.test(request.method))) ||
    (request.body !== undefined && typeof request.body !== 'string') ||
    (expect.status !== undefined &&
      (typeof expect.status !== 'number' ||
        !Number.isInteger(expect.status) ||
        expect.status < 200 ||
        expect.status > 599)) ||
    (expect.bodyBytes !== undefined &&
      (typeof expect.bodyBytes !== 'number' ||
        !Number.isSafeInteger(expect.bodyBytes) ||
        expect.bodyBytes < 0))
  ) {
    throw new Error('Invalid request or response expectations.');
  }
  const headers = request.headers === undefined ? {} : request.headers;
  if (
    !headers ||
    typeof headers !== 'object' ||
    Array.isArray(headers) ||
    Object.entries(headers).some(
      ([key, value]) =>
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
        typeof value !== 'string' ||
        /[\r\n]/.test(value) ||
        /^(cookie|authorization|cf-access-client-id|cf-access-client-secret)$/i.test(key),
    )
  ) {
    throw new Error(
      'Invalid request headers; authentication headers must not be stored in benchmark configuration.',
    );
  }
  return {
    method: (request.method ?? 'GET') as string,
    headers: headers as Record<string, string>,
    body: request.body as string | undefined,
    status: (expect.status ?? 200) as number,
    bodyBytes: expect.bodyBytes as number | undefined,
  };
}

function origin(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Expected an HTTP(S) origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

async function latency(options: Exclude<ReturnType<typeof parseLatencyArgs>, { help: true }>) {
  const app = path.join(benchmarkRoot, options.benchmark);
  if (!fs.existsSync(path.join(app, 'cloudflare.config.ts')) || fs.realpathSync(app) !== app) {
    throw new Error(`Not a benchmark app: ${options.benchmark}`);
  }

  let deployment;
  if (!options.origin) {
    deployment = JSON.parse(fs.readFileSync(path.join(app, 'artifacts/deploy/stats.json'), 'utf8'));
    if (
      deployment.status !== 'success' ||
      deployment.benchmark !== options.benchmark ||
      typeof deployment.url !== 'string'
    ) {
      throw new Error('Expected successful deployment stats for this benchmark; deploy it first.');
    }
  }

  const base = options.origin ?? origin(deployment.url);
  const url = new URL(options.path, base).href;
  const access = options.access || (!options.origin && Boolean(deployment.access?.id));
  if (access && !base.startsWith('https://')) {
    throw new Error('Access authentication requires HTTPS.');
  }

  const machine = getMachineInfo();
  const artifacts = path.join(app, 'artifacts/latency');
  checkLocalPath(app, artifacts);
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const lock = path.join(artifacts, '.latency.lock');
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`A latency run is already running (or left a stale lock): ${lock}`);
    }
    throw error;
  }

  let child: ChildProcess | undefined;
  let interrupted = false;
  let token = '';
  const redact = (value: string) => (token ? value.replaceAll(token, '[REDACTED]') : value);
  const onSignal = () => {
    interrupted = true;
    if (child?.pid) {
      // Stop the active oha process group before releasing the run lock.
      try {
        if (process.platform === 'win32') {
          child.kill('SIGTERM');
        } else {
          process.kill(-child.pid, 'SIGTERM');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const stats: LatencyStats = {
    schemaVersion: 1,
    benchmark: options.benchmark,
    url,
    deployment: deployment
      ? { workerId: deployment.workerId, versionId: deployment.versionId }
      : null,
    machine,
    status: 'failed',
    startedAt: new Date().toISOString(),
    settings: {
      requests: options.requests,
      connections: options.connections,
      duration: options.duration,
      rate: options.rate,
      timeout: options.timeout,
      httpVersion: options.httpVersion,
      keepAlive: true,
      redirects: 0,
      warmupRequests: options.warmupRequests,
      runs: options.runs,
      ...(options.request ? { request: options.request } : {}),
      access: access ? (process.env.CF_ACCESS_TOKEN ? 'environment' : 'temporary-login') : 'none',
    },
  };

  async function command(file: string, args: Array<string>, outputPrefix?: string) {
    if (interrupted) {
      throw new Error('Latency run interrupted.');
    }

    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const code = await new Promise<number | null>((resolve) => {
      child = spawn(file, args, {
        cwd: app,
        env: { ...process.env, NO_COLOR: '1' },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr!.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => (failure = error));
      child.on('close', (code) => {
        child = undefined;
        resolve(code);
      });
    });

    if (outputPrefix) {
      fs.writeFileSync(`${outputPrefix}.stdout`, redact(stdout), { mode: 0o600 });
      fs.writeFileSync(`${outputPrefix}.stderr`, redact(stderr), { mode: 0o600 });
    }
    if (interrupted) {
      throw new Error('Latency run interrupted.');
    }
    if (failure) {
      throw new Error(`Could not start ${file}; install it and ensure it is on PATH.`);
    }
    return { stdout: redact(stdout), stderr: redact(stderr), code };
  }

  let directory: string | undefined;
  try {
    directory = fs.mkdtempSync(path.join(artifacts, `${stats.startedAt.replace(/[:.]/g, '-')}-`));
    stats.artifacts = directory;
    process.stderr.write(`Measuring ${url}; artifacts: ${directory}\n`);

    const version = await command('oha', ['--version']);
    if (version.code !== 0) {
      throw new Error('oha --version failed.');
    }
    stats.ohaVersion = version.stdout.trim();

    if (access) {
      token = await getAccessToken(base);
    }

    const commonArgs = [
      '--no-tui',
      '--output-format',
      'json',
      '--http-version',
      options.httpVersion,
      '--redirect',
      '0',
      '-c',
      String(options.connections),
      '-t',
      options.timeout,
      ...(options.rate ? ['-q', String(options.rate)] : []),
      ...(options.request
        ? [
            '-m',
            options.request.method,
            ...Object.entries(options.request.headers).flatMap(([key, value]) => [
              '-H',
              `${key}: ${value}`,
            ]),
            ...(options.request.body === undefined ? [] : ['--body', options.request.body]),
          ]
        : []),
      ...(token ? ['-H', `Cookie: CF_Authorization=${token}`] : []),
    ];
    const rounds: Array<Array<number>> = [];
    const runs: Array<LatencyRound> = (stats.runs = []);
    fs.mkdirSync(path.join(directory, 'runs'));
    // The analytics window deliberately covers warmups as well as measurements.
    stats.measurementStartedAt = new Date().toISOString();
    for (let index = 0; index < options.runs; index++) {
      const runDirectory = path.join(directory, 'runs', String(index + 1).padStart(3, '0'));
      fs.mkdirSync(runDirectory);
      const run: LatencyRound = {
        artifacts: runDirectory,
        startedAt: new Date().toISOString(),
        status: 'failed',
        stage: 'warmup',
      };
      runs.push(run);
      process.stderr.write(`Latency round ${index + 1}/${options.runs}\n`);
      async function measure(name: string, args: Array<string>, expected: number | null) {
        const result = await command(
          'oha',
          [...commonArgs, ...args, url],
          path.join(runDirectory, name),
        );
        if (result.code !== 0) {
          throw new Error(`oha exited ${result.code}; see ${runDirectory}/${name}.stderr`);
        }
        const data = JSON.parse(result.stdout) as OhaResult;
        writeJson(path.join(runDirectory, `${name}.json`), data);
        validateOhaResult(data, expected, options.request?.status);
        const bodyBytes = options.request
          ? options.request.bodyBytes
          : new URL(url).pathname === '/'
            ? 0
            : undefined;
        const count = data.statusCodeDistribution[String(options.request?.status ?? 200)];
        if (bodyBytes !== undefined && data.summary.totalData !== count * bodyBytes) {
          throw new Error(
            `Expected ${bodyBytes === 0 ? 'an empty response' : `${bodyBytes} response body bytes`} on ${options.path}; check the deployment and Access.`,
          );
        }
        return data;
      }
      try {
        if (options.warmupRequests > 0) {
          run.warmup = await measure(
            'warmup',
            ['-n', String(options.warmupRequests)],
            options.warmupRequests,
          );
        }
        run.stage = 'measurement';
        run.measurementStartedAt = new Date().toISOString();
        const databaseFile = path.join(runDirectory, 'requests.sqlite');
        run.oha = await measure(
          'oha',
          [
            ...(options.duration
              ? ['-z', options.duration, '--wait-ongoing-requests-after-deadline']
              : ['-n', String(options.requests)]),
            '--db-url',
            databaseFile,
          ],
          options.requests,
        );
        run.measurementFinishedAt = new Date().toISOString();
        const samples = await readRequestDurations(
          databaseFile,
          run.oha.statusCodeDistribution[String(options.request?.status ?? 200)],
          options.request?.status,
        );
        rounds.push(samples);
        writeJson(path.join(runDirectory, 'samples.json'), {
          units: 'seconds',
          durations: samples,
        });
        run.stage = 'complete';
        run.status = 'success';
      } catch (error) {
        run.error = redact(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        run.finishedAt = new Date().toISOString();
        stats.measurementFinishedAt = run.finishedAt;
        writeJson(path.join(runDirectory, 'stats.json'), run);
      }
    }
    stats.statistics = summarizeLatencyRounds(rounds);
    const total = runs.reduce((sum, run) => sum + Number(run.oha!.summary.total), 0);
    const totalData = runs.reduce((sum, run) => sum + Number(run.oha!.summary.totalData), 0);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(totalData) || totalData < 0) {
      throw new Error('Expected finite oha elapsed times and response byte counts.');
    }
    // Compatibility summary, derived from measured requests only. Original oha
    // output is retained per round, including its own percentile convention.
    stats.oha = {
      summary: {
        successRate: 1,
        total,
        totalData,
        average: stats.statistics.metrics.mean.estimate,
        fastest: stats.statistics.min,
        slowest: stats.statistics.max,
        requestsPerSec: stats.statistics.requests / total,
      },
      latencyPercentiles: {
        p50: stats.statistics.metrics.p50.estimate,
        p95: stats.statistics.metrics.p95.estimate,
        p99: stats.statistics.p99,
      },
      statusCodeDistribution: { [options.request?.status ?? 200]: stats.statistics.requests },
      errorDistribution: {},
    };
    writeJson(path.join(directory, 'oha.json'), stats.oha);
    stats.status = 'success';
  } catch (error) {
    stats.error = redact(error instanceof Error ? error.message : String(error));
    throw new Error(stats.error);
  } finally {
    stats.finishedAt = new Date().toISOString();
    try {
      if (directory) {
        writeJson(path.join(directory, 'stats.json'), stats);
        if (stats.status === 'success') {
          checkLocalPath(app, path.join(artifacts, 'stats.json'));
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

interface OhaResult {
  summary: { successRate: number; [key: string]: unknown };
  statusCodeDistribution: Record<string, number>;
  errorDistribution: Record<string, number>;
  [key: string]: unknown;
}

export function validateOhaResult(data: OhaResult, requests: number | null, status = 200) {
  if (
    data.summary?.successRate !== 1 ||
    !data.statusCodeDistribution ||
    Object.keys(data.statusCodeDistribution).length !== 1 ||
    !Number.isSafeInteger(data.statusCodeDistribution[String(status)]) ||
    data.statusCodeDistribution[String(status)] < 1 ||
    (requests !== null && data.statusCodeDistribution[String(status)] !== requests) ||
    !data.errorDistribution ||
    Object.keys(data.errorDistribution).length !== 0
  ) {
    throw new Error(
      `Expected only HTTP ${status} responses and no request errors; check Access and oha.json.`,
    );
  }
}

export interface LatencyRound {
  artifacts: string;
  startedAt: string;
  finishedAt?: string;
  measurementStartedAt?: string;
  measurementFinishedAt?: string;
  status: 'success' | 'failed';
  stage: 'warmup' | 'measurement' | 'complete';
  warmup?: OhaResult;
  oha?: OhaResult;
  error?: string;
}

interface LatencyStats {
  schemaVersion: number;
  benchmark: string;
  url: string;
  deployment: { workerId: string | null; versionId: string | null } | null;
  machine: ReturnType<typeof getMachineInfo>;
  status: 'success' | 'failed';
  startedAt: string;
  finishedAt?: string;
  measurementStartedAt?: string;
  measurementFinishedAt?: string;
  settings: Record<string, unknown>;
  artifacts?: string;
  ohaVersion?: string;
  oha?: OhaResult;
  runs?: Array<LatencyRound>;
  statistics?: ReturnType<typeof summarizeLatencyRounds>;
  error?: string;
}

export async function readRequestDurations(file: string, expected: number, status = 200) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    // oha 1.17 stores durations in seconds and records only completed requests.
    const rows = database.prepare('SELECT duration, status FROM oha ORDER BY start, rowid').all();
    if (
      rows.length !== expected ||
      rows.some(
        (row) =>
          row.status !== status ||
          typeof row.duration !== 'number' ||
          !Number.isFinite(row.duration) ||
          row.duration < 0,
      )
    ) {
      throw new Error(
        'oha request database does not match the successful response count/durations.',
      );
    }
    return rows.map((row) => row.duration as number);
  } finally {
    database.close();
  }
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
