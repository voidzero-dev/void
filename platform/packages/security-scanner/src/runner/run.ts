// One scan inside the container: read /scan/task.json, run the phases with the
// task's engine, write /scan/out/findings.json and then /scan/out/status.json.
// The controller (M6) polls for status.json, so it is written last and renamed
// into place whole.

import { constants } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createClaudeEngine } from './engines/claude.ts';
import { createCodexEngine } from './engines/codex.ts';
import type { Engine, EngineId } from './engines/types.ts';
import { createVoidLoopEngine, MODEL_BASE_URL } from './engines/void-loop.ts';
import { runPhases, type PhasesResult } from './phases.ts';
import { FINDINGS_SCHEMA_VERSION, type FindingsFile } from './report.ts';
import { CopyClient } from './runtime/copy.ts';
import { outcomeStatus, type StatusFields, type StatusFile } from './status.ts';
import { parseTaskText, TaskError, type ScanTask } from './task.ts';
import { createFsTools, type FsTools } from './tools/fs.ts';
import { validateFindingsValue } from './validate-findings.ts';

export const RUNNER_VERSION = 'runner/1';

export type EngineFactory = (
  task: ScanTask,
  context: {
    tools: FsTools;
    /** The real directory that stands for `/scan`. */
    root: string;
    baseUrl: string;
    fetch?: typeof fetch;
    retryDelayMs?: number;
  },
) => Engine | null;

export type RunScanOptions = {
  /** The real directory that stands for `/scan`. */
  root: string;
  displayRoot?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Tests replace the engines. Default: B everywhere; A and C where their SDK is installed. */
  engineFactory?: EngineFactory;
  signal?: AbortSignal;
  now?: () => Date;
  retryDelayMs?: number;
  /** A failure before the scan started (for example a bad input tar). A stop on `signal` wins. */
  startError?: { errorClass: string; message: string };
  /** M30: the runtime copy route (default `http://copy.void.internal`) and, for tests, its wait. */
  copyBaseUrl?: string;
  copyReadyWaitMs?: number;
};

export const defaultEngineFactory: EngineFactory = (task, context) => {
  switch (task.engine) {
    case 'void_loop':
      return createVoidLoopEngine({
        model: task.model,
        tools: context.tools,
        baseUrl: context.baseUrl,
        fetch: context.fetch,
        retryDelayMs: context.retryDelayMs,
      });
    case 'agent_sdk':
      // A scanner image without the SDK ends the scan `failed (engine_unavailable)`.
      return createClaudeEngine({
        model: task.model,
        root: context.root,
        baseUrl: context.baseUrl,
        fetch: context.fetch,
      });
    case 'codex_sdk':
      return createCodexEngine({
        model: task.model,
        root: context.root,
        baseUrl: `${context.baseUrl}/v1`,
        fetch: context.fetch,
      });
    default:
      return null;
  }
};

type Identity = {
  scanId: string | null;
  attempt: number | null;
  engine: EngineId | null;
  engineVersion: string;
  model: string | null;
};

export async function runScan(options: RunScanOptions): Promise<StatusFile> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const outDir = join(options.root, 'out');
  await prepareOutDir(outDir);

  const identity: Identity = {
    scanId: null,
    attempt: null,
    engine: null,
    engineVersion: RUNNER_VERSION,
    model: null,
  };
  let phases: PhasesResult | null = null;
  let failure: (StatusFields & { message: string | null }) | null = null;

  try {
    if (options.signal?.aborted) {
      // Stopped before the scan began (SIGTERM while the input tar came in).
      failure = { ...outcomeStatus({ kind: 'aborted' }), message: null };
    } else if (options.startError) {
      failure = infrastructure(options.startError.errorClass, options.startError.message);
    } else {
      const task = await readTask(options.root);
      identity.scanId = task.scanId;
      identity.attempt = task.attempt;
      identity.engine = task.engine;
      identity.model = task.model;
      const tools = createFsTools({ root: options.root, displayRoot: options.displayRoot });
      const engine = (options.engineFactory ?? defaultEngineFactory)(task, {
        tools,
        root: options.root,
        baseUrl: options.baseUrl ?? MODEL_BASE_URL,
        fetch: options.fetch,
        retryDelayMs: options.retryDelayMs,
      });
      if (engine === null) {
        failure = infrastructure(
          'engine_unavailable',
          `engine ${task.engine} is not in this scanner image`,
        );
      } else {
        identity.engineVersion = `${RUNNER_VERSION} ${engine.version}`;
        phases = await runPhases({
          engine,
          task,
          hasMemory: await isRegularFile(join(options.root, 'memory', 'index.json')),
          copy: new CopyClient({
            baseUrl: options.copyBaseUrl,
            fetch: options.fetch,
            signal: options.signal,
            readyWaitMs: options.copyReadyWaitMs,
          }),
          signal: options.signal,
        });
      }
    }
  } catch (error) {
    failure =
      error instanceof TaskError
        ? infrastructure('task_invalid', error.message)
        : infrastructure('runner_crash', `runner stopped: ${errorName(error)}`);
  }

  let findings: FindingsFile = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    run_status: 'incomplete',
    findings: [],
    notes: '',
  };
  let fields: StatusFields = failure ?? phases!;
  if (phases && failure === null) {
    findings = {
      ...findings,
      run_status: phases.status === 'succeeded' ? 'complete' : 'incomplete',
      findings: phases.findings,
    };
    // The file the API ingests must pass the same check the model's report did.
    if (!validateFindingsValue(findings).ok) {
      fields = {
        status: 'failed',
        reason: 'bad_output',
        errorClass: 'final_report',
        refusalCategory: null,
      };
      findings = { ...findings, findings: [] };
    }
  }

  const status: StatusFile = {
    schema_version: 1,
    scan_id: identity.scanId,
    attempt: identity.attempt,
    engine: identity.engine,
    engine_version: identity.engineVersion,
    model: identity.model,
    status: fields.status,
    reason: fields.reason,
    error_class: fields.errorClass,
    refusal_category: fields.refusalCategory,
    message: failure?.message ?? null,
    sessions: phases?.sessions ?? [],
    model_calls: phases?.modelCalls ?? 0,
    tokens_in: phases?.tokensIn ?? 0,
    tokens_out: phases?.tokensOut ?? 0,
    findings: countVerdicts(findings),
    started_at: startedAt,
    finished_at: now().toISOString(),
  };
  await writeWhole(join(outDir, 'findings.json'), `${JSON.stringify(findings)}\n`);
  await writeWhole(join(outDir, 'status.json'), `${JSON.stringify(status)}\n`);
  return status;
}

function infrastructure(errorClass: string, message: string): StatusFields & { message: string } {
  return {
    status: 'failed',
    reason: 'infrastructure',
    errorClass,
    refusalCategory: null,
    message: message.slice(0, 500),
  };
}

async function readTask(root: string): Promise<ScanTask> {
  const path = join(root, 'task.json');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new TaskError('task.json is missing or not a regular file');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new TaskError('task.json is not a regular file');
    }
    if (stat.size > 1024 * 1024) {
      throw new TaskError('task.json is too large');
    }
    return parseTaskText(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

async function prepareOutDir(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const stat = await lstat(outDir);
  if (!stat.isDirectory()) {
    throw new Error('the output folder is not a directory');
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** Writes to a temp name, then renames, so a reader never sees half a file. */
async function writeWhole(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp`;
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

function countVerdicts(file: FindingsFile): StatusFile['findings'] {
  const counts = { confirmed: 0, needs_validation: 0, rejected: 0 };
  for (const finding of file.findings) {
    counts[finding.verdict]++;
  }
  return counts;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}
