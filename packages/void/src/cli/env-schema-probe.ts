import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findEnvFile } from '../codegen/env-types.ts';
import type { SelfHostSchemaFacts, SelfHostSchemaFailureReason } from './env-validation.ts';

/**
 * Runs the project's env.ts for the self-host deploy in a child process. The caller
 * passes the build env with Cloudflare credentials removed. Two operations: `facts`
 * (server and required key names) and `validate-emitted` (emitted vars that fail the
 * schema). The child writes its result to fd 3 and its stdout/stderr are ignored, so
 * user output cannot corrupt the result or print a secret into the deploy log.
 * Anything unexpected fails closed.
 */

/** argv[2] marker that runs this module as the child. */
const PROBE_MARKER = '__void-deploy-env-schema-probe__';

const RESULT_FD = 3;

type EnvSchemaProbeOp = 'facts' | 'validate-emitted';

export type EnvSchemaProbeInput = { root: string };

type ChildInput = { op: EnvSchemaProbeOp; root: string };

export type EnvSchemaProbeResult =
  | { kind: 'ok'; facts: SelfHostSchemaFacts }
  | { kind: 'schema-error'; reason: SelfHostSchemaFailureReason };

export type EnvSchemaValidateResult =
  | { kind: 'invalid-keys'; invalidKeys: Array<string> }
  | { kind: 'schema-error'; reason: SelfHostSchemaFailureReason };

type EnvSchemaProbeRawResult = EnvSchemaProbeResult | EnvSchemaValidateResult;

export type EnvSchemaProbeSpawnResult = {
  status: number | null;
  fd3: string | null;
  error?: Error | null;
  signal?: NodeJS.Signals | null;
};

export type EnvSchemaProbeSpawn = (
  command: string,
  args: Array<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => EnvSchemaProbeSpawnResult;

const defaultSpawn: EnvSchemaProbeSpawn = (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  const fd3 = result.output?.[RESULT_FD];
  return {
    status: result.status,
    fd3: typeof fd3 === 'string' ? fd3 : fd3 == null ? null : String(fd3),
    error: result.error ?? null,
    signal: result.signal ?? null,
  };
};

/** Run this module as the child for one operation and parse its fd-3 result. */
async function spawnEnvSchemaProbe(
  op: EnvSchemaProbeOp,
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
  spawn: EnvSchemaProbeSpawn,
): Promise<EnvSchemaProbeRawResult> {
  const childInput: ChildInput = { op, root: input.root };
  const self = fileURLToPath(import.meta.url);
  const result = spawn(process.execPath, [self, PROBE_MARKER, JSON.stringify(childInput)], {
    cwd: input.root,
    env,
  });
  if (result.error) {
    throw new Error(`could not spawn the env-schema probe: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`the env-schema probe was killed by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`the env-schema probe exited with code ${String(result.status)}.`);
  }
  const parsed = parseProbeResult(result.fd3 ?? '');
  if (!parsed) {
    throw new Error('the env-schema probe produced no parseable result.');
  }
  return parsed;
}

/** Runs before the build so a broken env.ts fails before any account operation. */
export async function resolveEnvSchemaFactsViaSubprocess(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
  spawn: EnvSchemaProbeSpawn = defaultSpawn,
): Promise<EnvSchemaProbeResult> {
  // File discovery executes no project code. An absent schema has no validators
  // to isolate; use the same resolver as the child, including sourceDir/extensions.
  if (findEnvFile(input.root) === null) {
    return { kind: 'ok', facts: { hasSchema: false, serverKeys: [], requiredKeys: [] } };
  }
  const result = await spawnEnvSchemaProbe('facts', input, env, spawn);
  if (result.kind === 'invalid-keys') {
    // The `facts` operation never emits invalid-keys; treat it as an infra fault.
    throw new Error('the env-schema probe returned an unexpected result for the facts operation.');
  }
  return result;
}

/** Runs after the build so it validates exactly the vars the Worker ships. */
export async function validateEmittedVarsViaSubprocess(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
  spawn: EnvSchemaProbeSpawn = defaultSpawn,
): Promise<EnvSchemaValidateResult> {
  const result = await spawnEnvSchemaProbe('validate-emitted', input, env, spawn);
  if (result.kind === 'ok') {
    // The `validate-emitted` operation never emits ok; treat it as infra.
    throw new Error(
      'the env-schema probe returned an unexpected result for the validate-emitted operation.',
    );
  }
  return result;
}

function parseProbeResult(fd3: string): EnvSchemaProbeRawResult | undefined {
  const trimmed = fd3.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as {
    kind?: unknown;
    facts?: unknown;
    reason?: unknown;
    invalidKeys?: unknown;
  };
  if (record.kind === 'ok' && isSchemaFacts(record.facts)) {
    return { kind: 'ok', facts: record.facts };
  }
  if (
    record.kind === 'invalid-keys' &&
    Array.isArray(record.invalidKeys) &&
    record.invalidKeys.every((k) => typeof k === 'string')
  ) {
    return { kind: 'invalid-keys', invalidKeys: record.invalidKeys };
  }
  if (
    record.kind === 'schema-error' &&
    (record.reason === 'schema-load-failed' || record.reason === 'schema-validation-error')
  ) {
    return { kind: 'schema-error', reason: record.reason };
  }
  return undefined;
}

function isSchemaFacts(value: unknown): value is SelfHostSchemaFacts {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const f = value as { hasSchema?: unknown; serverKeys?: unknown; requiredKeys?: unknown };
  return (
    typeof f.hasSchema === 'boolean' &&
    Array.isArray(f.requiredKeys) &&
    f.requiredKeys.every((k) => typeof k === 'string') &&
    Array.isArray(f.serverKeys) &&
    f.serverKeys.every((k) => typeof k === 'string')
  );
}

function emitResult(result: EnvSchemaProbeRawResult): void {
  writeSync(RESULT_FD, JSON.stringify(result));
}

async function runFactsChild(root: string): Promise<void> {
  const { deriveSelfHostSchemaFacts, SelfHostSchemaError } = await import('./env-validation.ts');
  try {
    const facts = await deriveSelfHostSchemaFacts(root);
    emitResult({ kind: 'ok', facts });
  } catch (err) {
    if (err instanceof SelfHostSchemaError) {
      emitResult({ kind: 'schema-error', reason: err.reason });
      return;
    }
    throw err;
  }
}

/** The parent already found the emitted config, so a read failure here fails closed. */
async function runValidateEmittedChild(root: string): Promise<void> {
  const { computeInvalidEmittedKeys, readEmittedWorkerVars, SelfHostSchemaError } =
    await import('./env-validation.ts');
  const emitted = readEmittedWorkerVars(root);
  if (!emitted.ok) {
    emitResult({ kind: 'schema-error', reason: 'schema-load-failed' });
    return;
  }
  try {
    const invalidKeys = await computeInvalidEmittedKeys(root, emitted.vars);
    emitResult({ kind: 'invalid-keys', invalidKeys });
  } catch (err) {
    if (err instanceof SelfHostSchemaError) {
      emitResult({ kind: 'schema-error', reason: err.reason });
      return;
    }
    throw err;
  }
}

async function runEnvSchemaProbeChild(rawInput: string): Promise<void> {
  const input = JSON.parse(rawInput) as ChildInput;
  if (input.op === 'validate-emitted') {
    await runValidateEmittedChild(input.root);
    return;
  }
  await runFactsChild(input.root);
}

// Child entry. Any unexpected failure exits nonzero; the parent fails closed on that.
if (process.argv[2] === PROBE_MARKER) {
  runEnvSchemaProbeChild(process.argv[3] ?? 'null').then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
