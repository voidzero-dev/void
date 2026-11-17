import fs from 'node:fs';
import path from 'node:path/posix';
import { parseLatencyArgs } from './latency.ts';
import { parseRunCount } from './statistics.ts';

export interface Workload {
  id: string;
  description: string;
  request: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  expect?: { status?: number; bodyBytes?: number };
  settings?: {
    rounds?: number;
    requests?: number;
    duration?: string;
    warmupRequests?: number;
    connections?: number;
    timeout?: string;
    httpVersion?: string;
    rate?: number;
  };
}

export interface BenchmarkConfig {
  deploy?: { runs?: number };
  latency?: Array<Workload>;
}

function object(value: unknown, keys: Array<string>, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(`Unknown ${label} field: ${key}`);
    }
  }
  return value as Record<string, unknown>;
}

export function resolveBenchmarkConfig(
  benchmark: string,
  input: unknown = {},
  overrides: { deployRuns?: number; latencyArgs: Array<string> } = { latencyArgs: [] },
) {
  const config = object(input, ['deploy', 'latency'], 'benchmark');
  const deploy = config.deploy === undefined ? {} : object(config.deploy, ['runs'], 'deploy');
  if (deploy.runs !== undefined && typeof deploy.runs !== 'number') {
    throw new Error('deploy.runs must be a number.');
  }
  const configuredDeployRuns = parseRunCount(String(deploy.runs ?? 30), 'deploy.runs');
  const deployRuns = overrides.deployRuns ?? configuredDeployRuns;
  const defaultWorkload: Workload = {
    id: 'baseline',
    description: 'Empty-response latency',
    request: { path: '/' },
    expect: { status: 200, bodyBytes: 0 },
  };
  const entries = config.latency === undefined ? [defaultWorkload] : config.latency;
  if (!Array.isArray(entries)) {
    throw new Error('latency must be an array.');
  }
  const ids = new Set<string>();
  const pathIndex = overrides.latencyArgs.indexOf('--path');
  // An explicit path retains the old one-workload CLI workflow.
  const selected =
    pathIndex < 0
      ? entries
      : [
          {
            id: 'custom',
            description: 'CLI-selected workload',
            request: { path: overrides.latencyArgs[pathIndex + 1] },
          },
        ];
  // Validate even entries superseded by --path before any remote activity.
  const validated = entries.map(validate);
  ids.clear();
  const workloads = pathIndex < 0 ? validated : selected.map(validate);
  return { deployRuns, workloads };

  function validate(value: unknown) {
    const entry = object(
      value,
      ['id', 'description', 'request', 'expect', 'settings'],
      'latency entry',
    );
    if (
      typeof entry.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) ||
      ids.has(entry.id)
    ) {
      throw new Error('Latency IDs must be unique lowercase kebab-case strings.');
    }
    ids.add(entry.id);
    if (typeof entry.description !== 'string' || !entry.description.trim()) {
      throw new Error('Each latency entry needs a description.');
    }
    const request = object(entry.request, ['path', 'method', 'headers', 'body'], 'request');
    if (typeof request.path !== 'string') {
      throw new Error('request.path must be a string.');
    }
    if (entry.expect !== undefined) {
      object(entry.expect, ['status', 'bodyBytes'], 'expect');
    }
    const settings =
      entry.settings === undefined
        ? {}
        : object(
            entry.settings,
            [
              'rounds',
              'requests',
              'duration',
              'warmupRequests',
              'connections',
              'timeout',
              'httpVersion',
              'rate',
            ],
            'latency settings',
          );
    const flags: Record<string, string> = {
      rounds: 'latency-runs',
      requests: 'requests',
      duration: 'duration',
      warmupRequests: 'warmup-requests',
      connections: 'connections',
      timeout: 'timeout',
      httpVersion: 'http-version',
      rate: 'rate',
    };
    for (const [key, value] of Object.entries(settings)) {
      const string = ['duration', 'timeout', 'httpVersion'].includes(key);
      if (typeof value !== (string ? 'string' : 'number')) {
        throw new Error(`latency.settings.${key} must be a ${string ? 'string' : 'number'}.`);
      }
    }
    if (settings.requests !== undefined && settings.duration !== undefined) {
      throw new Error('Use requests or duration, not both.');
    }
    const cli = new Map<string, string>();
    for (let index = 0; index < overrides.latencyArgs.length; index += 2) {
      cli.set(overrides.latencyArgs[index].slice(2), overrides.latencyArgs[index + 1]);
    }
    const configured = new Map(
      Object.entries(settings).map(([key, value]) => [flags[key], String(value)]),
    );
    const workload = entry as unknown as Workload;
    const requestArgs = [
      '--path',
      workload.request.path,
      '--request-json',
      JSON.stringify({ request: workload.request, expect: workload.expect }),
    ];
    // Validate configured values even when a CLI override would replace them.
    parseLatencyArgs([
      benchmark,
      ...requestArgs,
      ...[...configured].flatMap(([key, value]) => [`--${key}`, value]),
    ]);
    const merged = new Map(configured);
    if (cli.has('duration')) {
      merged.delete('requests');
    }
    if (cli.has('requests')) {
      merged.delete('duration');
    }
    for (const [key, value] of cli) {
      merged.set(key, value);
    }
    merged.delete('path');
    const args = [...requestArgs, ...[...merged].flatMap(([key, value]) => [`--${key}`, value])];
    const options = parseLatencyArgs([benchmark, ...args]);
    if (options.help) {
      throw new Error('Invalid latency settings.');
    }
    return { ...workload, args, effectiveSettings: options };
  }
}

export function loadBenchmarkConfig(app: string) {
  const file = path.join(app, 'benchmark.json');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    throw new Error(`Refusing to use a symlink: ${file}`);
  }
  return stat ? (JSON.parse(fs.readFileSync(file, 'utf8')) as unknown) : {};
}
