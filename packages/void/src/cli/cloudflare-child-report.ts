import {
  cloudflareCommandDiagnostic,
  type CloudflareCommandResult,
  type CloudflareOperation,
} from '@void/deploy-cloudflare';
import { redactMessage } from '../shared/env-mask.ts';
import { WRANGLER_AUTH_CREDENTIAL_ENV_VARS } from '../shared/untrusted-env.ts';
import type { CfCommand } from './cf-version-api.ts';
import { isCleanCloudflareExit } from './cloudflare-process.ts';
import type { DeployWranglerRun } from './deploy-types.ts';
import type { CliLogger } from './log-file.ts';

// Emails and the Access client id identify an account; they are not secrets, and
// scrubbing them would mangle ordinary messages.
const NOT_SECRET = new Set<string>(['CLOUDFLARE_EMAIL', 'CF_EMAIL', 'CLOUDFLARE_ACCESS_CLIENT_ID']);
const CREDENTIAL_ENV_VARS: ReadonlyArray<string> = [
  ...WRANGLER_AUTH_CREDENTIAL_ENV_VARS.filter((name) => !NOT_SECRET.has(name)),
  'CF_ACCESS_CLIENT_SECRET',
];
// Shorter values would match ordinary words.
const MIN_SECRET_LENGTH = 8;

/** Exact-value scrubber for the credentials this deploy holds. */
export type CredentialRedactor = {
  redact(text: string): string;
  /** Add a credential learned at run time, such as an OAuth bearer. */
  add(value: unknown): void;
};

export function createCredentialRedactor(env: NodeJS.ProcessEnv = process.env): CredentialRedactor {
  const values = new Set<string>();
  let ordered: Array<string> = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    for (const candidate of [value, value.trim()]) {
      if (candidate.length >= MIN_SECRET_LENGTH && !values.has(candidate)) {
        values.add(candidate);
        // Longer first, so a value that contains another is removed whole.
        ordered = [...values].sort((a, b) => b.length - a.length);
      }
    }
  };
  for (const name of CREDENTIAL_ENV_VARS) {
    add(env[name]);
  }
  return {
    add,
    redact(text) {
      let out = text;
      for (const value of ordered) {
        out = redactMessage(value, out);
      }
      return out;
    },
  };
}

/** One redactor per deploy, shared by every observed runner so a learned bearer covers them all. */
export type CloudflareChildReporter = {
  cliLog: CliLogger;
  redactor: CredentialRedactor;
};

export function createCloudflareChildReporter(
  cliLog: CliLogger,
  env: NodeJS.ProcessEnv = process.env,
): CloudflareChildReporter {
  return { cliLog, redactor: createCredentialRedactor(env) };
}

/**
 * Scrub exact credential values from a child result. This must run before any formatter
 * truncates the text, or a token that crosses the cut would leak its prefix. A clean
 * stdout and `data` are left alone: callers parse them, and they carry results, not errors.
 */
export function scrubCloudflareResult<T extends CloudflareCommandResult>(
  result: T,
  redactor: CredentialRedactor,
): T {
  return {
    ...result,
    stderr: redactor.redact(result.stderr),
    ...(isCleanCloudflareExit(result) ? {} : { stdout: redactor.redact(result.stdout) }),
    ...(result.error ? { error: redactor.redact(result.error) } : {}),
    ...(result.errors
      ? {
          errors: result.errors.map((error) => ({
            ...error,
            message: redactor.redact(error.message),
          })),
        }
      : {}),
  };
}

/** Scrub a runner rejection in place, so fields callers check on the Error survive. */
export function scrubCloudflareError(error: unknown, redactor: CredentialRedactor): Error {
  if (!(error instanceof Error)) {
    return new Error(redactor.redact(String(error)));
  }
  error.message = redactor.redact(error.message);
  if (typeof error.stack === 'string') {
    error.stack = redactor.redact(error.stack);
  }
  return error;
}

/** Why a child failed: its spawn error, the signal that stopped it, or its exit code. */
export function describeCloudflareChildFailure(
  result: Pick<CloudflareCommandResult, 'status' | 'signal' | 'error'>,
  subject = 'the Void CLI helper process',
): string {
  if (result.error) {
    return `${subject} could not run: ${result.error}`;
  }
  if (result.signal) {
    return `${subject} was stopped by ${result.signal}`;
  }
  return `${subject} exited with code ${String(result.status)}`;
}

/**
 * The cause sentence, then the child's bounded diagnostic. stdout is never shown: for
 * auth.token it is the credential envelope. The spawn error is already in the cause.
 */
export function formatCloudflareChildFailure(
  result: Pick<CloudflareCommandResult, 'status' | 'signal' | 'error' | 'stderr'>,
  subject?: string,
): string {
  const diagnostic = cloudflareCommandDiagnostic({
    status: result.status,
    stdout: '',
    stderr: result.stderr,
  });
  const cause = `${describeCloudflareChildFailure(result, subject)}.`;
  return diagnostic ? `${cause}\n${diagnostic}` : cause;
}

/** `cf` plus up to three leading subcommand words, so values and flags stay out of the log. */
export function cfOperationName(args: ReadonlyArray<string>): string {
  const words: Array<string> = [];
  for (const arg of args) {
    if (words.length === 3 || arg.startsWith('-')) {
      break;
    }
    words.push(arg);
  }
  return ['cf', ...words].join(' ');
}

function logCloudflareOp(
  reporter: CloudflareChildReporter,
  op: string,
  startedAt: number,
  outcome: { result: CloudflareCommandResult } | { thrown: Error },
): void {
  const ms = Date.now() - startedAt;
  if ('thrown' in outcome) {
    reporter.cliLog.debug('cloudflare_op', {
      op,
      ok: false,
      ms,
      diagnostic: cloudflareCommandDiagnostic({
        status: 1,
        stdout: '',
        stderr: outcome.thrown.message,
      }),
    });
    return;
  }
  const { result } = outcome;
  const ok = isCleanCloudflareExit(result);
  reporter.cliLog.debug('cloudflare_op', {
    op,
    ok,
    status: result.status,
    ...(result.signal ? { signal: result.signal } : {}),
    ms,
    ...(ok
      ? {}
      : {
          diagnostic: cloudflareCommandDiagnostic({
            ...result,
            // auth.token stdout is the credential envelope; never format it.
            stdout: op === 'auth.token' ? '' : result.stdout,
          }),
        }),
  });
}

/**
 * Observe the deploy's operation-child runner: scrub every result, learn the session
 * bearer from a clean auth.token, and write one debug `cloudflare_op` record per child.
 * Inputs (`opts.input` carries secret values) and result data are never logged.
 */
export function observeCloudflareRunner(
  run: DeployWranglerRun,
  reporter: CloudflareChildReporter,
): DeployWranglerRun {
  return async (operation: CloudflareOperation, opts) => {
    const startedAt = Date.now();
    let result: CloudflareCommandResult;
    try {
      result = await run(operation, opts);
    } catch (error) {
      const thrown = scrubCloudflareError(error, reporter.redactor);
      logCloudflareOp(reporter, operation.type, startedAt, { thrown });
      throw thrown;
    }
    if (operation.type === 'auth.token' && isCleanCloudflareExit(result)) {
      const data = result.data as { token?: unknown } | null | undefined;
      reporter.redactor.add(data?.token);
    }
    const scrubbed = scrubCloudflareResult(result, reporter.redactor);
    logCloudflareOp(reporter, operation.type, startedAt, { result: scrubbed });
    return scrubbed;
  };
}

/** Observe the pinned cf CLI the same way. */
export function observeCfCommand(run: CfCommand, reporter: CloudflareChildReporter): CfCommand {
  return async (args, opts) => {
    const op = cfOperationName(args);
    const startedAt = Date.now();
    let result: CloudflareCommandResult;
    try {
      result = await run(args, opts);
    } catch (error) {
      const thrown = scrubCloudflareError(error, reporter.redactor);
      logCloudflareOp(reporter, op, startedAt, { thrown });
      throw thrown;
    }
    const scrubbed = scrubCloudflareResult(result, reporter.redactor);
    logCloudflareOp(reporter, op, startedAt, { result: scrubbed });
    return scrubbed;
  };
}
