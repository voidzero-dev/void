// `/scan/task.json`: what the API asks this scan to do. Built by the API (M10),
// written into the container by the controller (M6). Unknown fields are ignored so
// an older Engine A/C image still reads a newer task.

import type { EngineId } from './engines/types.ts';
import { SCAN_INPUT_LIMITS } from './limits.ts';
import { relativePathProblem } from './validate-findings.ts';

export const TASK_TIERS = ['source_diff', 'built_diff', 'full'] as const;
export type TaskTier = (typeof TASK_TIERS)[number];

/**
 * `deploy_diff`: the per-deploy profile. `standard`: scheduled full sweeps (M25), one
 * hunt session per focus area. A profile this runner does not know runs as
 * `deploy_diff`, so a newer API never fails an older image.
 */
export const TASK_PROFILES = ['deploy_diff', 'standard'] as const;
export type TaskProfile = (typeof TASK_PROFILES)[number];

export const TASK_ENGINES = [
  'void_loop',
  'agent_sdk',
  'codex_sdk',
] as const satisfies ReadonlyArray<EngineId>;

/** Spec §6.3: 40 turns per session, at most 10 verify sessions. */
export const TASK_LIMITS = {
  maxTurns: 40,
  maxVerify: 10,
  maxTaskBytes: 1024 * 1024,
  maxChangedFiles: 5000,
} as const;

export type ScanTask = {
  scanId: string;
  attempt: number;
  engine: EngineId;
  model: string;
  tier: TaskTier;
  profile: TaskProfile;
  /** Paths relative to `/scan/input` that changed since the base (empty for `full`). */
  changedFiles: Array<string>;
  maxTurns: number;
  maxVerify: number;
};

export class TaskError extends Error {}

export function parseTaskText(text: string): ScanTask {
  if (Buffer.byteLength(text, 'utf8') > TASK_LIMITS.maxTaskBytes) {
    throw new TaskError('task.json is too large');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TaskError('task.json is not valid JSON');
  }
  return parseTask(value);
}

export function parseTask(value: unknown): ScanTask {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskError('task.json must be an object');
  }
  const task = value as Record<string, unknown>;
  if (task.version !== 1) {
    throw new TaskError('task.json version must be 1');
  }
  const scanId = readId(task.scan_id, 'scan_id');
  const attempt = task.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    throw new TaskError('attempt must be a whole number of at least 1');
  }
  const engine = readOneOf(task.engine, 'engine', TASK_ENGINES);
  const model = readId(task.model, 'model');
  const tier = readOneOf(task.tier, 'tier', TASK_TIERS);
  const changedFiles = readChangedFiles(task.changed_files);
  const profile = TASK_PROFILES.find((value) => value === task.profile) ?? 'deploy_diff';
  const limits = task.limits === undefined ? {} : task.limits;
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    throw new TaskError('limits must be an object');
  }
  const { max_turns: maxTurns, max_verify: maxVerify } = limits as Record<string, unknown>;
  return {
    scanId,
    attempt,
    engine,
    model,
    tier,
    profile,
    changedFiles,
    maxTurns: readLimit(maxTurns, 'limits.max_turns', TASK_LIMITS.maxTurns, 1),
    maxVerify: readLimit(maxVerify, 'limits.max_verify', TASK_LIMITS.maxVerify, 0),
  };
}

function readId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new TaskError(`${name} must be a non-empty string`);
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      throw new TaskError(`${name} must not hold spaces or control characters`);
    }
  }
  return value;
}

function readOneOf<T extends string>(value: unknown, name: string, values: ReadonlyArray<T>): T {
  if (typeof value !== 'string' || !(values as ReadonlyArray<string>).includes(value)) {
    throw new TaskError(`${name} must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function readChangedFiles(value: unknown): Array<string> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TaskError('changed_files must be an array');
  }
  if (value.length > TASK_LIMITS.maxChangedFiles) {
    throw new TaskError(`changed_files must hold at most ${TASK_LIMITS.maxChangedFiles} paths`);
  }
  return value.map((path, index) => {
    if (typeof path !== 'string' || path.length > SCAN_INPUT_LIMITS.maxTaskPathChars) {
      throw new TaskError(`changed_files[${index}] must be a path`);
    }
    const problem = relativePathProblem(path);
    if (problem !== null) {
      throw new TaskError(`changed_files[${index}] ${problem}`);
    }
    return path;
  });
}

/** A lower limit from the API is kept; a higher one is cut to the spec maximum. */
function readLimit(value: unknown, name: string, max: number, min: number): number {
  if (value === undefined) {
    return max;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new TaskError(`${name} must be a whole number of at least ${min}`);
  }
  return Math.min(value, max);
}
