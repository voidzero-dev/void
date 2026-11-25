// One scan inside the container: read /scan/task.json, run the phases with the
// task's engine, write /scan/out/findings.json and then /scan/out/status.json.
// The controller polls for status.json, so it is written last and renamed into place whole.

import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path/posix';
import { createClaudeEngine } from './engines/claude.ts';
import { createCodexEngine } from './engines/codex.ts';
import type { Engine } from './engines/types.ts';
import { createVoidLoopEngine, MODEL_BASE_URL } from './engines/void-loop.ts';
import { runPhases } from './phases.ts';
import type { PhasesResult } from './phases.ts';
import { FINDINGS_SCHEMA_VERSION } from './report.ts';
import type { FindingsFile } from './report.ts';
import { CopyClient } from './runtime/copy.ts';
import { outcomeStatus } from './status.ts';
import type { StatusFields, StatusFile } from './status.ts';
import { parseTaskText, TASK_LIMITS, TaskError } from './task.ts';
import type { ScanTask } from './task.ts';
import { createFsTools } from './tools/fs.ts';
import { writeWhole } from './util.ts';
import { validateFindingsValue } from './validate-findings.ts';

export const RUNNER_VERSION = 'runner/1';

export type RunScanOptions = {
  /** The real directory that stands for `/scan`. */
  root: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
  retryDelayMs?: number;
  /** A failure before the scan started (for example a bad input tar). A stop on `signal` wins. */
  startError?: { errorClass: string; message: string };
};

/** B everywhere; A and C where their SDK is installed (else `failed (engine_unavailable)`). */
function createEngine(task: ScanTask, options: RunScanOptions, baseUrl: string): Engine {
  const shared = { model: task.model, root: options.root, fetch: options.fetch };
  switch (task.engine) {
    case 'void_loop':
      return createVoidLoopEngine({
        ...shared,
        tools: createFsTools({ root: options.root }),
        baseUrl,
        retryDelayMs: options.retryDelayMs,
      });
    case 'agent_sdk':
      return createClaudeEngine({ ...shared, baseUrl });
    case 'codex_sdk':
      return createCodexEngine({ ...shared, baseUrl: `${baseUrl}/v1` });
  }
}

type Failure = StatusFields & { message: string | null };

function infrastructure(errorClass: string, message: string): Failure {
  return {
    status: 'failed',
    reason: 'infrastructure',
    errorClass,
    refusalCategory: null,
    message: message.slice(0, 500),
  };
}

export async function runScan(options: RunScanOptions): Promise<StatusFile> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const outDir = join(options.root, 'out');
  await mkdir(outDir, { recursive: true });
  if (!(await lstat(outDir)).isDirectory()) {
    throw new Error('the output folder is not a directory');
  }

  let task: ScanTask | null = null;
  let engineVersion = RUNNER_VERSION;
  let phases: PhasesResult | null = null;
  let failure: Failure | null = null;

  try {
    if (options.signal?.aborted) {
      // Stopped before the scan began (SIGTERM while the input tar came in).
      failure = { ...outcomeStatus({ kind: 'aborted' }), message: null };
    } else if (options.startError) {
      failure = infrastructure(options.startError.errorClass, options.startError.message);
    } else {
      task = await readTask(options.root);
      const engine = createEngine(task, options, options.baseUrl ?? MODEL_BASE_URL);
      engineVersion = `${RUNNER_VERSION} ${engine.version}`;
      phases = await runPhases({
        engine,
        task,
        hasMemory: await isRegularFile(join(options.root, 'memory', 'index.json')),
        copy: new CopyClient({ fetch: options.fetch, signal: options.signal }),
        signal: options.signal,
      });
    }
  } catch (error) {
    failure =
      error instanceof TaskError
        ? infrastructure('task_invalid', error.message)
        : infrastructure(
            'runner_crash',
            `runner stopped: ${error instanceof Error ? error.name : 'error'}`,
          );
  }

  let findings: FindingsFile = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    run_status: 'incomplete',
    findings: [],
    notes: '',
  };
  // One of the two is always set above.
  let fields: StatusFields =
    failure ?? phases ?? infrastructure('runner_crash', 'runner stopped: no result');
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

  const counts = { confirmed: 0, needs_validation: 0, rejected: 0 };
  for (const finding of findings.findings) {
    counts[finding.verdict]++;
  }
  const status: StatusFile = {
    schema_version: 1,
    scan_id: task?.scanId ?? null,
    attempt: task?.attempt ?? null,
    engine: task?.engine ?? null,
    engine_version: engineVersion,
    model: task?.model ?? null,
    status: fields.status,
    reason: fields.reason,
    error_class: fields.errorClass,
    refusal_category: fields.refusalCategory,
    message: failure?.message ?? null,
    sessions: phases?.sessions ?? [],
    model_calls: phases?.modelCalls ?? 0,
    tokens_in: phases?.tokensIn ?? 0,
    tokens_out: phases?.tokensOut ?? 0,
    findings: counts,
    started_at: startedAt,
    finished_at: now().toISOString(),
  };
  await writeWhole(join(outDir, 'findings.json'), `${JSON.stringify(findings)}\n`);
  await writeWhole(join(outDir, 'status.json'), `${JSON.stringify(status)}\n`);
  return status;
}

async function readTask(root: string): Promise<ScanTask> {
  let handle;
  try {
    handle = await open(join(root, 'task.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new TaskError('task.json is missing or not a regular file');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new TaskError('task.json is not a regular file');
    }
    if (stat.size > TASK_LIMITS.maxTaskBytes) {
      throw new TaskError('task.json is too large');
    }
    return parseTaskText(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
