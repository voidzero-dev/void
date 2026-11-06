import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathslash';

type Level = 'debug' | 'info' | 'warn' | 'error';

export type CliLogger = {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, err?: unknown, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  /** path to the file backing this logger, or null if unable to open */
  readonly path: string | null;
  /** Release the file. Every record is already on disk when its call returns. Idempotent. */
  close(): Promise<void>;
};

export type ErrChainNode = {
  name?: string;
  message?: string;
  code?: string | number;
  errno?: string | number;
  cause?: ErrChainNode;
};

/**
 * Flatten a serialized `ErrChainNode` (from `describeErrorChain`, or read back
 * out of a JSONL record) to a single inline string, joining cause levels with
 * ` -> `.
 */
export function formatErrorNodeInline(
  node: ErrChainNode | string | null | undefined,
  depth = 0,
): string {
  // `typeof null` is `'object'`, so the null check has to come first.
  if (node == null || typeof node !== 'object') {
    return String(node);
  }
  // A JSONL record is data, not a typed value. Coerce every part instead of
  // trusting the declared shape: a hand-edited log, or an `Error` subclass that
  // assigned a non-string `message`, must not make a postmortem aid throw.
  const message = node.message == null ? '' : String(node.message);
  if (depth > 5) {
    return message;
  }
  let head = node.name ? `${String(node.name)}: ${message}` : message;
  const tags: Array<string> = [];
  if (node.code !== undefined) {
    tags.push(`code=${node.code}`);
  }
  if (node.errno !== undefined) {
    tags.push(`errno=${node.errno}`);
  }
  if (tags.length > 0) {
    head = `${head} (${tags.join(' ')})`;
  }
  if (node.cause != null) {
    return `${head} -> ${formatErrorNodeInline(node.cause, depth + 1)}`;
  }
  return head;
}

/**
 * Walk `err.cause` up to 6 levels and return a plain JSON-friendly chain.
 * Skips stack traces deliberately — keeps output line-oriented and readable.
 */
function describeErrorChain(err: unknown, depth = 0): ErrChainNode | string {
  if (depth > 5 || err == null) {
    return String(err);
  }
  if (err instanceof Error) {
    const node: ErrChainNode = {
      name: err.name,
      message: err.message,
    };
    const code = (err as Error & { code?: string | number }).code;
    if (code !== undefined) {
      node.code = code;
    }
    const errno = (err as Error & { errno?: string | number }).errno;
    if (errno !== undefined) {
      node.errno = errno;
    }
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause != null) {
      const sub = describeErrorChain(cause, depth + 1);
      if (typeof sub === 'object') {
        node.cause = sub;
      } else {
        node.cause = { message: sub };
      }
    }
    return node;
  }
  return String(err);
}

function formatStderrLine(
  level: Level,
  msg: string,
  err: unknown | undefined,
  fields?: Record<string, unknown>,
): string {
  const parts: Array<string> = [level, msg];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) {
        continue;
      }
      let s: string;
      if (v == null || typeof v === 'number' || typeof v === 'boolean') {
        s = String(v);
      } else if (typeof v === 'string') {
        s = v.length > 200 ? `${v.slice(0, 200)}...` : v;
      } else {
        try {
          s = JSON.stringify(v);
        } catch {
          s = String(v);
        }
      }
      parts.push(`${k}=${s}`);
    }
  }
  if (err !== undefined) {
    parts.push(`-> err=${formatErrorNodeInline(describeErrorChain(err))}`);
  }
  return parts.join(' ');
}

export function openDeployLog(opts?: { mirrorToStderr?: boolean }): CliLogger {
  const mirror = opts?.mirrorToStderr === true;
  const startedAt = Date.now();

  let path: string | null = null;
  let fd: number | null = null;
  let broken = false;
  let closed = false;
  // The CLI exits through process.exit() on many failure paths, and more than one of them may
  // try to record the end of the deploy. Only the first deploy_end counts.
  let ended = false;

  try {
    const dir = join(homedir(), '.void', 'logs');
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // Deploys started in the same millisecond (parallel deploys from one
    // machine) must not share a file, so add the pid and a random suffix and
    // refuse to open a file that already exists.
    const suffix = randomBytes(3).toString('hex');
    const filePath = join(dir, `deploy-${ts}-${process.pid}-${suffix}.jsonl`);
    // Synchronous writes, so a record survives a process.exit() that follows it: a stream
    // would still hold it in memory. The log can carry account and project details, so only
    // the owner may read it.
    fd = openSync(filePath, 'wx', 0o600);
    path = filePath;
  } catch {
    broken = true;
    path = null;
    fd = null;
  }

  function write(
    level: Level,
    msg: string,
    err: unknown | undefined,
    fields?: Record<string, unknown>,
  ): void {
    if (msg === 'deploy_end') {
      if (ended) {
        return;
      }
      ended = true;
    }
    if (mirror) {
      try {
        process.stderr.write(`${formatStderrLine(level, msg, err, fields)}\n`);
      } catch {
        // Stderr write failures are not actionable.
      }
    }
    if (broken || fd === null || closed) {
      return;
    }
    const now = Date.now();
    const record: Record<string, unknown> = {
      ts: now,
      elapsedMs: now - startedAt,
      lvl: level,
      msg,
    };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (
          v !== undefined &&
          k !== 'ts' &&
          k !== 'elapsedMs' &&
          k !== 'lvl' &&
          k !== 'msg' &&
          k !== 'err'
        ) {
          record[k] = v;
        }
      }
    }
    if (err !== undefined) {
      record.err = describeErrorChain(err);
    }
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      // Non-serializable fields shouldn't crash the logger; fall back to a
      // minimal record.
      line = `${JSON.stringify({ ts: now, elapsedMs: now - startedAt, lvl: level, msg, err: 'unserializable fields' })}\n`;
    }
    try {
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(fd, bytes, offset);
      }
    } catch {
      // A full disk or a closed descriptor must never break the deploy; stop logging instead.
      broken = true;
    }
  }

  return {
    get path() {
      return path;
    },
    info(msg, fields) {
      write('info', msg, undefined, fields);
    },
    warn(msg, fields) {
      write('warn', msg, undefined, fields);
    },
    error(msg, err, fields) {
      write('error', msg, err, fields);
    },
    debug(msg, fields) {
      write('debug', msg, undefined, fields);
    },
    close(): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Nothing is buffered, so a failed close loses no record.
        }
        fd = null;
      }
      return Promise.resolve();
    },
  };
}
