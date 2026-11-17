import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path/posix';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { getMachineInfo } from './machine.ts';
import { bootstrapMethod, parseRunCount, summarizeSamples } from './statistics.ts';

const benchmarkRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage: node benchmark/scripts/deploy.ts <benchmark-name> [options]

  --benchmark       Repeat clean build-and-deploy measurements (default: 30 runs)
  --runs <n>        Measured deployments, 1–1000; requires --benchmark
  -h, --help        Show usage

Without --benchmark, deploy once. Every run is retained; the first is not discarded.
Benchmark summaries use 95% bootstrap intervals; 30 runs do not guarantee significance.`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);

  try {
    const options = parseDeployArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
    } else {
      await deploy(options.id, options.runs, options.benchmark);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function parseDeployArgs(args: Array<string>) {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      benchmark: { type: 'boolean' },
      runs: { type: 'string' },
    },
  });
  if (values.help) {
    return { help: true } as const;
  }
  if (positionals.length !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(positionals[0])) {
    throw new Error(usage);
  }
  if (values.runs !== undefined && !values.benchmark) {
    throw new Error('--runs requires --benchmark.');
  }
  return {
    help: false,
    id: positionals[0],
    benchmark: values.benchmark ?? false,
    runs: parseRunCount(values.runs ?? (values.benchmark ? '30' : '1'), '--runs'),
  } as const;
}

async function deploy(id: string, requestedRuns: number, benchmark: boolean) {
  const app = path.join(benchmarkRoot, id);

  if (
    !fs.existsSync(path.join(app, 'cloudflare.config.ts')) ||
    fs.realpathSync(app) !== app ||
    readJson(path.join(app, 'package.json')).scripts?.build !== 'vp build'
  ) {
    throw new Error(`Not a benchmark app using vp build: ${id}`);
  }

  // Keep local machine/network inspection outside the measured deployment workflow.
  const machine = getMachineInfo();

  const artifacts = path.join(app, 'artifacts/deploy');
  checkLocalPath(app, artifacts);
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });

  const lock = path.join(artifacts, '.deploy.lock');

  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`A deployment is already running (or left a stale lock): ${lock}`);
    }

    throw error;
  }

  let result: DeploymentStats | undefined;
  let directory: string | undefined;
  const startedAt = new Date().toISOString();
  const runs: Array<DeploymentStats> = [];
  let printed = false;
  try {
    if (benchmark) {
      directory = fs.mkdtempSync(path.join(artifacts, `${startedAt.replace(/[:.]/g, '-')}-`));
      fs.mkdirSync(path.join(directory, 'runs'));
    }
    for (let index = 0; index < requestedRuns; index++) {
      process.stderr.write(`Deployment ${index + 1}/${requestedRuns}\n`);
      const run = await deployAttempt(
        id,
        app,
        artifacts,
        machine,
        index === requestedRuns - 1,
        directory ? path.join(directory, 'runs', String(index + 1).padStart(3, '0')) : undefined,
      );
      runs.push(run);
      result = run;
      if (run.status !== 'success') {
        break;
      }
      if (run.workerId !== runs[0].workerId || run.url !== runs[0].url) {
        run.status = 'failed';
        run.error = 'Worker identity changed during the deployment batch.';
        writeJson(path.join(run.artifacts!, 'stats.json'), run);
        break;
      }
    }
    if (benchmark && result) {
      const successful = runs.filter((run) => run.status === 'success');
      const timingKeys = [
        'buildReportedMs',
        'uploadReportedMs',
        'triggersReportedMs',
        'workerStartupMs',
        'cfDeployWallMs',
        'cleanWallMs',
        'workerLookupWallMs',
      ] as const;
      result = {
        ...result,
        startedAt,
        finishedAt: new Date().toISOString(),
        artifacts: directory,
        batch: {
          requestedRuns,
          completedRuns: successful.length,
          failedRuns: runs.length - successful.length,
          notRun: requestedRuns - runs.length,
          startedAt,
          finishedAt: new Date().toISOString(),
          runs,
          statistics: Object.fromEntries(
            timingKeys.map((key) => [
              key,
              summarizeSamples(
                runs.map((run) => (run.status === 'success' ? run.timings[key] : null)),
              ),
            ]),
          ),
          bundle: Object.fromEntries(
            ['rawBytes', 'gzipBytes'].map((key) => {
              const values = successful.flatMap((run) =>
                run.bundle ? [run.bundle[key as 'rawBytes' | 'gzipBytes']] : [],
              );
              return [
                key,
                {
                  count: values.length,
                  min: values.length ? Math.min(...values) : null,
                  max: values.length ? Math.max(...values) : null,
                },
              ];
            }),
          ),
          bootstrap: bootstrapMethod,
        },
      };
    }
    if (result) {
      if (benchmark) {
        writeJson(path.join(directory!, 'stats.json'), result);
      }
      if (result.status === 'success') {
        checkLocalPath(app, path.join(artifacts, 'stats.json'));
        writeJson(path.join(artifacts, 'stats.json'), result);
      }
      console.log(JSON.stringify(result));
      printed = true;
      if (result.status !== 'success') {
        throw new Error(result.error ?? 'Deployment failed.');
      }
    }
  } catch (error) {
    if (result && !printed) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      writeJson(path.join(result.artifacts!, 'stats.json'), result);
      console.log(JSON.stringify(result));
    }
    throw error;
  } finally {
    fs.rmdirSync(lock);
  }
}

async function deployAttempt(
  id: string,
  app: string,
  artifacts: string,
  machine: ReturnType<typeof getMachineInfo>,
  setupAccess: boolean,
  fixedDirectory?: string,
) {
  const started = performance.now();
  const stats: DeploymentStats = {
    schemaVersion: 1,
    benchmark: id,
    machine,
    startedAt: new Date().toISOString(),
    status: 'failed',
    workerName: null,
    workerId: null,
    versionId: null,
    url: null,
    bundle: null,
    timings: {
      ...parseDeployLog('', `void-perf-${id}`),
      cfDeployWallMs: null,
      workflowWallMs: null,
      cleanWallMs: null,
      workerLookupWallMs: null,
      accessWallMs: null,
    },
    access: null,
    cache: {
      appBuild: 'clean',
      frameworkBuilds: 'preserved',
      nodeCompileCache: 'disabled',
      remoteUpload: 'Cloudflare asset deduplication is not disabled',
    },
  };

  let runDirectory: string | undefined;
  let interrupted = false;
  let activeChild: ChildProcess | undefined;
  let lookupStarted: number | undefined;
  let accessStarted: number | undefined;

  const onSignal = () => {
    interrupted = true;

    // Kill cf and its build subprocesses before releasing the per-app lock.
    if (activeChild?.pid) {
      try {
        process.kill(-activeChild.pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
    }
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const directory =
      fixedDirectory ??
      fs.mkdtempSync(path.join(artifacts, `${stats.startedAt.replace(/[:.]/g, '-')}-`));
    if (fixedDirectory) {
      fs.mkdirSync(directory);
    }
    runDirectory = directory;
    stats.artifacts = runDirectory;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      NODE_DISABLE_COMPILE_CACHE: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      WRANGLER_LOG_SANITIZE: 'true',
    };

    // Do not leak an inherited output destination or debug setting into unrelated API commands.
    delete env.DEBUG;
    delete env.WRANGLER_OUTPUT_FILE_PATH;
    delete env.WRANGLER_OUTPUT_FILE_DIRECTORY;
    delete env.CLOUDFLARE_CI_OVERRIDE_WORKER_NAME;
    delete env.WRANGLER_CI_OVERRIDE_NAME;

    async function cf(
      args: Array<string>,
      label: string,
      overrides: NodeJS.ProcessEnv = {},
      json = true,
    ) {
      if (interrupted) {
        throw new Error('Deployment interrupted.');
      }

      const logPath = path.join(directory, `${label}.log`);
      const fd = fs.openSync(logPath, 'wx', 0o600);

      let stdout = '';
      let failure: Error | undefined;
      let code: number | null;

      try {
        code = await new Promise<number | null>((accept) => {
          const child = (activeChild = spawn('cf', args, {
            cwd: app,
            env: { ...env, ...overrides },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          }));

          child.stdout.on('data', (chunk) => {
            fs.writeSync(fd, chunk);

            if (json) {
              stdout += chunk.toString();
            }
          });
          child.stderr.on('data', (chunk) => fs.writeSync(fd, chunk));

          child.on('error', (error) => {
            failure = error;
          });

          child.on('close', (code) => {
            activeChild = undefined;
            accept(code);
          });
        });
      } finally {
        fs.closeSync(fd);
      }

      if (failure || code !== 0 || interrupted) {
        throw new Error(
          `cf ${args.slice(0, 5).join(' ')} failed (${failure?.message ?? (interrupted ? 'interrupted' : `exit ${code}`)}); see ${logPath}`,
        );
      }

      if (!json) {
        return;
      }

      const result = JSON.parse(stdout);
      writeJson(path.join(directory, `${label}.json`), result);

      return result;
    }

    stats.stage = 'clean';

    // cf delegates to the built-in `vp build`, not a cache-restoring `vp run` task.
    const clean = ['.cloudflare/output', '.void', 'dist', '.vite', 'node_modules/.vite'];

    for (const cleanPath of clean) {
      checkLocalPath(app, path.join(app, cleanPath));
    }

    for (const cleanPath of clean) {
      fs.rmSync(path.join(app, cleanPath), { recursive: true, force: true });
    }

    stats.cache.cleared = clean;
    stats.timings.cleanWallMs = performance.now() - started;

    stats.stage = 'deploy';
    process.stderr.write(`Deploying ${id}; artifacts: ${runDirectory}\n`);

    const deployStarted = performance.now();

    try {
      await cf(
        ['deploy'],
        'deploy',
        { DEBUG: '1', WRANGLER_OUTPUT_FILE_PATH: path.join(directory, 'deploy.ndjson') },
        false,
      );
    } finally {
      stats.timings.cfDeployWallMs = performance.now() - deployStarted;
      Object.assign(
        stats.timings,
        parseDeployLog(
          fs.readFileSync(path.join(directory, 'deploy.log'), 'utf8'),
          `void-perf-${id}`,
        ),
      );
    }

    const records = fs
      .readFileSync(path.join(directory, 'deploy.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === 'deploy' && entry.version_id);

    if (records.length !== 1) {
      throw new Error('Expected exactly one successful deploy JSON record.');
    }

    const record = records[0];

    if (
      record.worker_name !== `void-perf-${id}` ||
      !Number.isFinite(record.bundle_size?.raw_bytes) ||
      !Number.isFinite(record.bundle_size?.gzip_bytes) ||
      record.bundle_size.raw_bytes < 0 ||
      record.bundle_size.gzip_bytes < 0
    ) {
      throw new Error('Deploy JSON is missing the benchmark Worker name or bundle sizes.');
    }

    const workerName: string = record.worker_name;
    stats.workerName = workerName;
    stats.versionId = record.version_id;
    stats.bundle = {
      rawBytes: record.bundle_size.raw_bytes,
      gzipBytes: record.bundle_size.gzip_bytes,
    };
    stats.targets = record.targets ?? [];

    stats.stage = 'worker';
    lookupStarted = performance.now();
    const worker = await cf(['workers', 'get', workerName], 'worker');

    if (!worker.id || worker.name !== stats.workerName || !worker.subdomain?.enabled) {
      throw new Error('Worker lookup did not return the expected Worker with workers.dev enabled.');
    }

    stats.workerId = worker.id;

    const hostname = worker.subdomain.url;

    if (!hostname) {
      throw new Error('Worker lookup did not return a workers.dev URL.');
    }

    const url = new URL(hostname.includes('://') ? hostname : `https://${hostname}`);

    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.workers.dev') ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('Unexpected workers.dev URL in Worker lookup.');
    }

    stats.url = url.origin;
    stats.timings.workerLookupWallMs = performance.now() - lookupStarted;

    if (!setupAccess) {
      stats.stage = 'complete';
      stats.status = 'success';
      return stats;
    }

    stats.stage = 'access';
    accessStarted = performance.now();
    const matches = [];

    for (let page = 1; ; page++) {
      const apps = await cf(
        [
          'zero-trust',
          'access',
          'applications',
          'list',
          '--domain',
          url.hostname,
          '--exact',
          '--per-page',
          '100',
          '--page',
          String(page),
        ],
        `access-list-${page}`,
      );

      if (!Array.isArray(apps)) {
        throw new Error('Expected an array of Access applications.');
      }

      matches.push(...apps.filter((application) => application.domain === url.hostname));

      if (apps.length < 100) {
        break;
      }
    }

    if (matches.length > 1) {
      throw new Error('Multiple Access applications match; left unchanged.');
    }

    if (matches.length) {
      const application = await cf(
        ['zero-trust', 'access', 'applications', 'get', matches[0].id],
        'access',
      );

      const policies = [];

      for (const policy of application.policies ?? []) {
        policies.push(
          policy.include
            ? policy
            : await cf(
                ['zero-trust', 'access', 'policies', 'get', policy.id ?? policy],
                `access-policy-${policies.length}`,
              ),
        );
      }

      stats.access = { id: application.id, action: 'unchanged' };

      if (
        application.type !== 'self_hosted' ||
        application.domain !== url.hostname ||
        policies.length !== 1 ||
        !isEmployeePolicy(policies[0])
      ) {
        throw new Error(
          `Access app ${application.id} has different policies; left unchanged. Review it in Zero Trust before retrying.`,
        );
      }

      stats.access.action = 'reused';
    } else {
      const body = {
        type: 'self_hosted',
        name: stats.workerName,
        domain: url.hostname,
        session_duration: '24h',
        policies: [
          {
            name: 'Allow Cloudflare emails',
            decision: 'allow',
            precedence: 1,
            include: [{ email_domain: { domain: 'cloudflare.com' } }],
          },
        ],
      };

      const bodyPath = path.join(directory, 'access-request.json');
      writeJson(bodyPath, body);

      const application = await cf(
        ['zero-trust', 'access', 'applications', 'create', '--body', `@${bodyPath}`],
        'access',
      );

      if (!application.id) {
        throw new Error('Access creation did not return an application ID.');
      }

      stats.access = { id: application.id, action: 'created' };
    }

    stats.stage = 'complete';
    stats.status = 'success';
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (accessStarted !== undefined) {
      stats.timings.accessWallMs = performance.now() - accessStarted;
    }
    if (lookupStarted !== undefined && stats.timings.workerLookupWallMs === null) {
      stats.timings.workerLookupWallMs = performance.now() - lookupStarted;
    }
    stats.timings.workflowWallMs = performance.now() - started;
    stats.finishedAt = new Date().toISOString();

    try {
      if (runDirectory) {
        writeJson(path.join(runDirectory, 'stats.json'), stats);
      }
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
  return stats;
}

export interface DeploymentStats {
  schemaVersion: number;
  benchmark: string;
  machine: ReturnType<typeof getMachineInfo>;
  startedAt: string;
  finishedAt?: string;
  status: 'failed' | 'success';
  stage?: string;
  workerName: string | null;
  workerId: string | null;
  versionId: string | null;
  url: string | null;
  bundle: { rawBytes: number; gzipBytes: number } | null;
  timings: ReturnType<typeof parseDeployLog> & {
    cfDeployWallMs: number | null;
    workflowWallMs: number | null;
    cleanWallMs: number | null;
    workerLookupWallMs: number | null;
    accessWallMs: number | null;
  };
  access: { id: string; action: 'unchanged' | 'created' | 'reused' } | null;
  cache: {
    appBuild: string;
    frameworkBuilds: string;
    nodeCompileCache: string;
    remoteUpload: string;
    cleared?: Array<string>;
  };
  artifacts?: string;
  targets?: Array<unknown>;
  error?: string;
  batch?: {
    requestedRuns: number;
    completedRuns: number;
    failedRuns: number;
    notRun: number;
    startedAt: string;
    finishedAt: string;
    runs: Array<DeploymentStats>;
    statistics: Record<string, ReturnType<typeof summarizeSamples>>;
    bundle: Record<string, { count: number; min: number | null; max: number | null }>;
    bootstrap: typeof bootstrapMethod;
  };
}

interface AccessPolicy {
  decision?: string;
  include?: Array<{ email_domain?: { domain?: string }; [key: string]: unknown }>;
  require?: Array<unknown>;
  exclude?: Array<unknown>;
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Never follow a symlink while clearing build output or writing credentials-adjacent logs.
function checkLocalPath(root: string, target: string) {
  let current = root;

  for (const part of path.relative(root, target).split('/')) {
    current = path.join(current, part);

    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refusing to use a symlink: ${current}`);
    }
  }
}

function milliseconds(value: string, unit: string) {
  const multipliers: Record<string, number> = { ms: 1, s: 1000, sec: 1000, m: 60_000 };

  return Number(value) * multipliers[unit];
}

export function parseDeployLog(raw: string, workerName: string) {
  const log = stripVTControlCharacters(raw);
  const builds = Array.from(log.matchAll(/\bbuilt in\s+([\d.]+)\s*(ms|s|m)\b/g), (match) =>
    milliseconds(match[1], match[2]),
  );

  const escapedName = workerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const duration = (pattern: RegExp) => {
    const match = log.match(pattern);

    return match ? milliseconds(match[1], match[2]) : null;
  };

  return {
    buildBundlesMs: builds,
    buildReportedMs: builds.length ? builds.reduce((sum, value) => sum + value, 0) : null,
    uploadReportedMs: duration(
      new RegExp(`\\bUploaded\\s+${escapedName}\\s+\\(([\\d.]+)\\s*(ms|s|sec)\\)`),
    ),
    triggersReportedMs: duration(
      new RegExp(`\\bDeployed\\s+${escapedName}\\s+triggers\\s+\\(([\\d.]+)\\s*(ms|s|sec)\\)`),
    ),
    workerStartupMs: duration(/\bWorker Startup Time:\s*([\d.]+)\s*(ms)\b/),
  };
}

function isEmployeePolicy(policy: AccessPolicy) {
  return (
    policy.decision === 'allow' &&
    policy.include?.length === 1 &&
    Object.keys(policy.include[0]).length === 1 &&
    policy.include[0].email_domain?.domain === 'cloudflare.com' &&
    !policy.require?.length &&
    !policy.exclude?.length
  );
}
