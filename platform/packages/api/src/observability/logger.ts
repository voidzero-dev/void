// Structured request-scoped logger for the API deploy pipeline. Each call
// emits exactly one JSON line to `console.log/warn/error` so Cloudflare Tail
// captures one `logs[]` entry per record with the appropriate level.
//
// Schema (stable):
//   { ts, lvl, area: 'deploy', phase, msg, ...context, ...fields, err? }
//
// `with(...)` returns a child logger with merged context; the parent is
// unchanged.

type Level = 'info' | 'warn' | 'error';

export type DeployLogContext = Readonly<{
  projectId: string;
  projectSlug?: string;
  userId?: string;
  deploymentId?: string;
  branch?: 'wfp' | 'static' | null;
  routingSwitched?: boolean;
}>;

export type DeployLogger = Readonly<{
  with(fields: Partial<DeployLogContext>): DeployLogger;
  info(phase: string, msg: string, fields?: Record<string, unknown>): void;
  warn(phase: string, msg: string, fields?: Record<string, unknown>): void;
  error(phase: string, msg: string, err: unknown, fields?: Record<string, unknown>): void;
}>;

const MAX_CAUSE_DEPTH = 6;

type SerializedError = {
  name?: string;
  message: string;
  code?: unknown;
  errno?: unknown;
  stack?: string;
  cause?: SerializedError;
};

function serializeError(input: unknown): SerializedError {
  // Walk the .cause chain up to MAX_CAUSE_DEPTH levels deep, defensively
  // tolerating non-Error inputs at every level. A logging call must never
  // throw because of a malformed error value.
  const seen = new WeakSet<object>();
  function step(value: unknown, depth: number): SerializedError {
    if (value && typeof value === 'object') {
      if (seen.has(value)) {
        return { message: '[circular]' };
      }
      seen.add(value);
    }
    if (value instanceof Error) {
      const node: SerializedError = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      if ('code' in value && value.code !== undefined) {
        node.code = value.code;
      }
      if ('errno' in value && value.errno !== undefined) {
        node.errno = value.errno;
      }
      if (depth < MAX_CAUSE_DEPTH && value.cause !== undefined) {
        node.cause = step(value.cause, depth + 1);
      }
      return node;
    }
    if (value === undefined) {
      return { message: 'undefined' };
    }
    try {
      return { message: String(value) };
    } catch {
      return { message: '[unserializable]' };
    }
  }
  return step(input, 0);
}

function emit(
  level: Level,
  context: DeployLogContext,
  phase: string,
  msg: string,
  fields?: Record<string, unknown>,
  err?: unknown,
): void {
  // Build the record defensively — a logging call must not throw because of
  // a non-serializable user field. On stringify failure, fall back to a
  // minimal record that preserves level + phase + msg.
  let line: string;
  try {
    type DeployLogRecord = DeployLogContext & {
      ts: number;
      lvl: Level;
      area: string;
      phase: string;
      msg: string;
      err?: ReturnType<typeof serializeError>;
    };
    const record: DeployLogRecord = {
      ts: Date.now(),
      lvl: level,
      area: 'deploy',
      phase,
      msg,
      ...context,
      ...(fields ?? {}),
    };
    if (err !== undefined) {
      record.err = serializeError(err);
    }
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({
      ts: Date.now(),
      lvl: level,
      area: 'deploy',
      phase,
      msg,
      err: { message: 'log: fields not serializable' },
    });
  }
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

class LoggerImpl implements DeployLogger {
  constructor(private readonly context: DeployLogContext) {}

  with(fields: Partial<DeployLogContext>): DeployLogger {
    return new LoggerImpl({ ...this.context, ...fields });
  }
  info(phase: string, msg: string, fields?: Record<string, unknown>): void {
    emit('info', this.context, phase, msg, fields);
  }
  warn(phase: string, msg: string, fields?: Record<string, unknown>): void {
    emit('warn', this.context, phase, msg, fields);
  }
  error(phase: string, msg: string, err: unknown, fields?: Record<string, unknown>): void {
    emit('error', this.context, phase, msg, fields, err);
  }
}

export function createDeployLogger(initial: DeployLogContext): DeployLogger {
  return new LoggerImpl(initial);
}
