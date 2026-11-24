import { readFileSync } from 'node:fs';
import pc from 'picocolors';
import { type ErrChainNode, formatErrorNodeInline } from './log-file.ts';

/** How many trailing records the tail block shows. */
export const LOG_TAIL_LIMIT = 20;
/** How many error records the error block shows. */
export const LOG_ERROR_LIMIT = 5;

const FIELD_VALUE_MAX = 80;
const LINE_MAX = 160;
const MSG_COLUMN_MAX = 28;
const ELAPSED_WIDTH = 7;
const LEVEL_WIDTH = 5;
/** Width of `'  ' + elapsed + '  '`, used to indent the error sub-lines. */
const DETAIL_INDENT = ' '.repeat(2 + ELAPSED_WIDTH + 2);

/**
 * `runDeploy` writes this record last, and its `err` field is the very message
 * printed above the summary. Keeping it out of the error block avoids echoing
 * the same text twice; it still shows up as one line in the tail.
 */
const TERMINAL_ERROR_MSG = 'deploy_end';

const RESERVED_KEYS = new Set(['ts', 'elapsedMs', 'lvl', 'msg', 'err']);

// The trace was a file the user opened by hand; the summary publishes it to
// whatever reads stderr, which in CI is a stored, often public, log.
//
// Scrubbing here covers only credentials this code emits itself — a presigned
// URL it built, an auth header it set, a field it named. Scrubbing user data is
// left to the CI platform, which owns the secrets and masks them before the log
// is written. GitHub Actions does this for everything under `secrets.*`. Void
// does not guess at credential-shaped names or at credentials embedded in
// values the user supplied.

/** Query parameters whose value must never reach a CI log. */
const SIGNED_QUERY_RE =
  /([?&](?:X-Amz-[A-Za-z0-9-]+|[Ss]ignature|sig|token|access_token|key)=)[^&\s]+/g;
const BEARER_RE = /\b(Bearer\s+)\S+/g;
/**
 * Field keys whose value is masked whole, whatever it looks like. `auth` is
 * deliberately absent — it matches metadata keys such as `authMethod` far more
 * often than credentials.
 */
const SECRET_KEY_RE =
  /token|secret|password|passwd|credential|cookie|signature|api[-_]?key|private[-_]?key/i;

type LogRecord = {
  elapsedMs?: number;
  lvl?: string;
  msg?: string;
  err?: ErrChainNode | string;
  [key: string]: unknown;
};

function redact(text: string): string {
  return text.replaceAll(SIGNED_QUERY_RE, '$1[redacted]').replaceAll(BEARER_RE, '$1[redacted]');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/** Collapse every run of whitespace so one record always renders as one line. */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Render one `key=value` pair, collapsed, redacted, and length-capped. */
function formatField(key: string, value: unknown): string {
  if (SECRET_KEY_RE.test(key)) {
    return `${key}=[redacted]`;
  }
  return `${key}=${truncate(redact(oneLine(stringifyValue(value))), FIELD_VALUE_MAX)}`;
}

function fieldPairs(record: LogRecord): Array<string> {
  const pairs: Array<string> = [];
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED_KEYS.has(key) || value === undefined) {
      continue;
    }
    pairs.push(formatField(key, value));
  }
  if (record.err !== undefined) {
    pairs.push(
      `err=${truncate(redact(oneLine(formatErrorNodeInline(record.err))), FIELD_VALUE_MAX)}`,
    );
  }
  return pairs;
}

function formatElapsed(elapsedMs: unknown): string {
  const ms = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? elapsedMs : 0;
  return `${(ms / 1000).toFixed(1)}s`.padStart(ELAPSED_WIDTH);
}

function colorLevel(level: string, padded: string): string {
  if (level === 'error') {
    return pc.red(padded);
  }
  if (level === 'warn') {
    return pc.yellow(padded);
  }
  // `info` and `debug` are context, not signal — dim them so the red and
  // yellow rows stand out in a wall of CI output.
  return pc.dim(padded);
}

function parseRecords(lines: Array<string>): Array<LogRecord> {
  const records: Array<LogRecord> = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as LogRecord);
      }
    } catch {
      // A partially flushed or corrupt line must not hide the rest of the log.
    }
  }
  return records;
}

/** One aligned line: `  8.9s  error  deploy_server_error  message=...`. */
function formatTailLine(record: LogRecord, msgWidth: number): string {
  const level = typeof record.lvl === 'string' ? record.lvl : 'info';
  const msg = typeof record.msg === 'string' ? record.msg : '';
  const elapsed = formatElapsed(record.elapsedMs);
  const paddedLevel = level.padEnd(LEVEL_WIDTH);
  const paddedMsg = msg.padEnd(msgWidth);
  const head = `  ${elapsed}  ${paddedLevel}  ${paddedMsg}`;
  const fields = fieldPairs(record).join(' ');
  if (!fields) {
    return `  ${elapsed}  ${colorLevel(level, paddedLevel)}  ${msg}`;
  }
  const budget = Math.max(20, LINE_MAX - head.length);
  return `  ${elapsed}  ${colorLevel(level, paddedLevel)}  ${paddedMsg}  ${truncate(fields, budget)}`;
}

/** An error entry: a headline, then one indented line per field. */
function formatErrorEntry(record: LogRecord): Array<string> {
  const msg = typeof record.msg === 'string' ? record.msg : 'error';
  const lines = [`  ${formatElapsed(record.elapsedMs)}  ${pc.red(msg)}`];
  for (const pair of fieldPairs(record)) {
    lines.push(`${DETAIL_INDENT}${pair}`);
  }
  return lines;
}

/**
 * Turn raw JSONL lines into the block appended to a failed deploy's error
 * message. Returns `null` when there is nothing worth printing.
 *
 * The block has two parts: every `error` record with its flattened cause
 * chain, then the last `LOG_TAIL_LIMIT` records for timeline context.
 */
export function formatDeployLogSummary(lines: Array<string>): string | null {
  const records = parseRecords(lines);
  if (records.length === 0) {
    return null;
  }

  const blocks: Array<string> = [];

  const errors = records.filter((r) => r.lvl === 'error' && r.msg !== TERMINAL_ERROR_MSG);
  if (errors.length > 0) {
    const shown = errors.slice(0, LOG_ERROR_LIMIT);
    const errorLines = shown.flatMap((record) => formatErrorEntry(record));
    if (errors.length > shown.length) {
      errorLines.push(`${DETAIL_INDENT}(+${errors.length - shown.length} more)`);
    }
    blocks.push([pc.bold('Errors'), ...errorLines].join('\n'));
  }

  const tail = records.slice(-LOG_TAIL_LIMIT);
  const msgWidth = Math.min(
    MSG_COLUMN_MAX,
    tail.reduce((max, r) => Math.max(max, typeof r.msg === 'string' ? r.msg.length : 0), 0),
  );
  const heading =
    records.length > tail.length
      ? `Last ${LOG_TAIL_LIMIT} of ${records.length} entries`
      : `Log (${records.length} ${records.length === 1 ? 'entry' : 'entries'})`;
  blocks.push(
    [pc.bold(heading), ...tail.map((record) => formatTailLine(record, msgWidth))].join('\n'),
  );

  return `\n${blocks.join('\n\n')}`;
}

/**
 * Read a deploy JSONL log and format its summary. Returns `null` for a missing
 * path or any read failure — a postmortem aid must never mask the real error.
 */
export function buildDeployLogSummary(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return formatDeployLogSummary(text.split('\n'));
}
