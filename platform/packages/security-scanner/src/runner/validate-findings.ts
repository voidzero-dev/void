// Container-side check of a findings report. Hand-written (no regex, no schema
// library) so the runner bundle stays dependency-free. The API reuses
// `validateFindingsValue` at ingest (M12); here it gives the model its one repair turn.

import {
  CONFIDENCES,
  FINDINGS_SCHEMA_VERSION,
  REPORT_LIMITS,
  RUN_STATUSES,
  RUNTIME_PROOF_METHODS,
  SEVERITIES,
  VERDICT_SOURCES,
  VERDICTS,
  type Confidence,
  type FindingRecord,
  type RunStatus,
  type RuntimeProof,
  type ScanReport,
  type Severity,
  type TraceStep,
  type Verdict,
  type VerdictSource,
} from './report.ts';

export type ValidationErrorKind = 'too_large' | 'not_json' | 'too_many_records' | 'shape';

export type ValidationResult =
  | { ok: true; report: ScanReport }
  | { ok: false; kind: ValidationErrorKind; path: string; message: string };

class ShapeError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

class CountError extends ShapeError {}

/** Checks the raw JSON text (tool-call arguments or a file). */
export function validateFindingsText(text: string): ValidationResult {
  if (Buffer.byteLength(text, 'utf8') > REPORT_LIMITS.maxBytes) {
    return {
      ok: false,
      kind: 'too_large',
      path: '$',
      message: `report is larger than ${REPORT_LIMITS.maxBytes} bytes`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, kind: 'not_json', path: '$', message: 'report is not valid JSON' };
  }
  return validateFindingsValue(value);
}

/** Checks an already parsed report. Paths under `/scan/input/` or `input/` are made relative. */
export function validateFindingsValue(value: unknown): ValidationResult {
  try {
    return { ok: true, report: readReport(value) };
  } catch (error) {
    if (error instanceof ShapeError) {
      return {
        ok: false,
        kind: error instanceof CountError ? 'too_many_records' : 'shape',
        path: error.path,
        message: error.message,
      };
    }
    throw error;
  }
}

/** One line the model can act on in its repair turn. */
export function describeValidationError(result: Extract<ValidationResult, { ok: false }>): string {
  return `${result.path}: ${result.message}`;
}

function readReport(value: unknown): ScanReport {
  const object = readObject(value, '$', ['run_status', 'findings', 'notes', 'schema_version']);
  if (object.schema_version !== undefined && object.schema_version !== FINDINGS_SCHEMA_VERSION) {
    throw new ShapeError('$.schema_version', `must be ${FINDINGS_SCHEMA_VERSION}`);
  }
  const runStatus = readEnum<RunStatus>(object.run_status, '$.run_status', RUN_STATUSES);
  if (!Array.isArray(object.findings)) {
    throw new ShapeError('$.findings', 'must be an array');
  }
  if (object.findings.length > REPORT_LIMITS.maxRecords) {
    throw new CountError('$.findings', `must hold at most ${REPORT_LIMITS.maxRecords} records`);
  }
  const findings = object.findings.map((record, index) =>
    readFinding(record, `$.findings[${index}]`),
  );
  const notes = readOptionalText(object.notes, '$.notes', REPORT_LIMITS.notes);
  return { run_status: runStatus, findings, notes };
}

const FINDING_KEYS = [
  'fingerprint',
  'verdict',
  'severity',
  'confidence',
  'title',
  'category',
  'cwe',
  'file',
  'line_start',
  'line_end',
  'sink_path',
  'outside_diff',
  'trace',
  'evidence',
  'conditions',
  'fix',
  'reason',
  'proof_request',
  'verdict_source',
  'runtime_proof',
] as const;

function readFinding(value: unknown, path: string): FindingRecord {
  const object = readObject(value, path, FINDING_KEYS);
  const verdict = readEnum<Verdict>(object.verdict, `${path}.verdict`, VERDICTS);
  const severity =
    object.severity === undefined || object.severity === null
      ? null
      : readEnum<Severity>(object.severity, `${path}.severity`, SEVERITIES);
  const confidence =
    object.confidence === undefined || object.confidence === null
      ? null
      : readEnum<Confidence>(object.confidence, `${path}.confidence`, CONFIDENCES);
  const lineStart = readLine(object.line_start, `${path}.line_start`);
  const lineEnd = readLine(object.line_end, `${path}.line_end`);
  if (lineStart !== null && lineEnd !== null && lineEnd < lineStart) {
    throw new ShapeError(`${path}.line_end`, 'must not be before line_start');
  }
  const outsideDiff = object.outside_diff ?? false;
  if (typeof outsideDiff !== 'boolean') {
    throw new ShapeError(`${path}.outside_diff`, 'must be a boolean');
  }
  const record: FindingRecord = {
    fingerprint: readText(object.fingerprint, `${path}.fingerprint`, REPORT_LIMITS.fingerprint),
    verdict,
    severity,
    confidence,
    title: readText(object.title, `${path}.title`, REPORT_LIMITS.title),
    category: readText(object.category, `${path}.category`, REPORT_LIMITS.category),
    cwe: readCwe(object.cwe, `${path}.cwe`),
    file: readPath(object.file, `${path}.file`),
    line_start: lineStart,
    line_end: lineEnd,
    sink_path:
      object.sink_path === undefined || object.sink_path === null
        ? null
        : readPath(object.sink_path, `${path}.sink_path`),
    outside_diff: outsideDiff,
    trace: readTrace(object.trace, `${path}.trace`),
    evidence: readOptionalText(object.evidence, `${path}.evidence`, REPORT_LIMITS.evidence),
    conditions: readOptionalText(object.conditions, `${path}.conditions`, REPORT_LIMITS.conditions),
    fix: readOptionalText(object.fix, `${path}.fix`, REPORT_LIMITS.fix),
    reason: readOptionalText(object.reason, `${path}.reason`, REPORT_LIMITS.reason),
  };
  // M30 fields: only present when given, so a static report reads as before.
  if (object.proof_request !== undefined) {
    record.proof_request =
      object.proof_request === null || object.proof_request === ''
        ? null
        : readText(object.proof_request, `${path}.proof_request`, REPORT_LIMITS.proofRequest);
  }
  if (object.verdict_source !== undefined) {
    record.verdict_source = readEnum<VerdictSource>(
      object.verdict_source,
      `${path}.verdict_source`,
      VERDICT_SOURCES,
    );
  }
  if (object.runtime_proof !== undefined) {
    record.runtime_proof =
      object.runtime_proof === null
        ? null
        : readRuntimeProof(object.runtime_proof, `${path}.runtime_proof`);
  }
  checkVerdictRules(record, path);
  return record;
}

function readRuntimeProof(value: unknown, path: string): RuntimeProof {
  const object = readObject(value, path, ['request', 'method', 'path', 'status']);
  const status = object.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new ShapeError(`${path}.status`, 'must be an HTTP status');
  }
  return {
    request: readText(object.request, `${path}.request`, REPORT_LIMITS.proofRequest),
    method: readEnum(object.method, `${path}.method`, RUNTIME_PROOF_METHODS),
    path: readText(object.path, `${path}.path`, REPORT_LIMITS.path),
    status,
  };
}

function checkVerdictRules(record: FindingRecord, path: string): void {
  if (record.verdict_source === 'runtime') {
    if (record.verdict !== 'confirmed') {
      throw new ShapeError(`${path}.verdict_source`, 'runtime is only for a confirmed finding');
    }
    if (!record.runtime_proof) {
      throw new ShapeError(`${path}.runtime_proof`, 'is required for a runtime confirmation');
    }
  }
  if (record.verdict === 'confirmed') {
    if (record.severity === null) {
      throw new ShapeError(`${path}.severity`, 'is required for a confirmed finding');
    }
    if (record.sink_path === null) {
      throw new ShapeError(`${path}.sink_path`, 'is required for a confirmed finding');
    }
    if (record.trace.length === 0) {
      throw new ShapeError(
        `${path}.trace`,
        'needs the source-to-sink steps for a confirmed finding',
      );
    }
    if (record.evidence.length === 0) {
      throw new ShapeError(`${path}.evidence`, 'is required for a confirmed finding');
    }
    if (record.fix.length === 0) {
      throw new ShapeError(`${path}.fix`, 'is required for a confirmed finding');
    }
    return;
  }
  if (record.severity !== null) {
    throw new ShapeError(`${path}.severity`, 'must be null unless the verdict is confirmed');
  }
  if (record.verdict === 'rejected' && record.reason.length === 0) {
    throw new ShapeError(`${path}.reason`, 'is required for a rejected finding');
  }
}

function readTrace(value: unknown, path: string): Array<TraceStep> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ShapeError(path, 'must be an array');
  }
  if (value.length > REPORT_LIMITS.traceSteps) {
    throw new ShapeError(path, `must hold at most ${REPORT_LIMITS.traceSteps} steps`);
  }
  return value.map((step, index) => {
    const stepPath = `${path}[${index}]`;
    const object = readObject(step, stepPath, ['file', 'line', 'note']);
    return {
      file: readPath(object.file, `${stepPath}.file`),
      line: readLine(object.line, `${stepPath}.line`),
      note: readOptionalText(object.note, `${stepPath}.note`, REPORT_LIMITS.traceNote),
    };
  });
}

function readObject<K extends string>(
  value: unknown,
  path: string,
  keys: ReadonlyArray<K>,
): Partial<Record<K, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShapeError(path, 'must be an object');
  }
  const allowed = new Set<string>(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ShapeError(`${path}.${key}`, 'is not an allowed field');
    }
  }
  return value as Partial<Record<K, unknown>>;
}

function readEnum<T extends string>(value: unknown, path: string, values: ReadonlyArray<T>): T {
  if (typeof value !== 'string' || !(values as ReadonlyArray<string>).includes(value)) {
    throw new ShapeError(path, `must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function readText(value: unknown, path: string, max: number): string {
  const text = readOptionalText(value, path, max);
  if (text.trim().length === 0) {
    throw new ShapeError(path, 'must not be empty');
  }
  return text;
}

function readOptionalText(value: unknown, path: string, max: number): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new ShapeError(path, 'must be a string');
  }
  if (value.length > max) {
    throw new ShapeError(path, `must be at most ${max} characters`);
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw new ShapeError(path, 'must not hold control characters');
    }
  }
  return value;
}

function readLine(value: unknown, path: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > REPORT_LIMITS.maxLine
  ) {
    throw new ShapeError(path, 'must be a whole line number or null');
  }
  return value;
}

function readCwe(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !value.startsWith('CWE-')) {
    throw new ShapeError(path, 'must look like CWE-79 or be null');
  }
  const digits = value.slice(4);
  if (digits.length === 0 || digits.length > 6 || !isDigits(digits)) {
    throw new ShapeError(path, 'must look like CWE-79 or be null');
  }
  return value;
}

function isDigits(text: string): boolean {
  for (const char of text) {
    if (char < '0' || char > '9') {
      return false;
    }
  }
  return true;
}

const INPUT_PREFIXES = ['/scan/input/', 'input/', './'];

/**
 * A file path relative to `/scan/input`. Accepts the `/scan/input/` and `input/`
 * forms the model sees in tool output and drops them; refuses `..`, absolute paths,
 * backslashes, empty segments and control characters.
 */
export function readPath(value: unknown, path: string): string {
  let text = readText(value, path, REPORT_LIMITS.path);
  for (const prefix of INPUT_PREFIXES) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  const problem = relativePathProblem(text);
  if (problem !== null) {
    throw new ShapeError(path, problem);
  }
  return text;
}

/** `null` when `text` is a clean relative POSIX path, else why it is not. */
export function relativePathProblem(text: string): string | null {
  if (text.length === 0) {
    return 'must be a file path under /scan/input';
  }
  if (text.startsWith('/')) {
    return 'must be relative to /scan/input';
  }
  if (text.includes('\\')) {
    return 'must use forward slashes';
  }
  // A newline or other control character could start a new line in a prompt.
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return 'must not hold control characters';
    }
  }
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return 'must not hold empty, "." or ".." segments';
    }
  }
  return null;
}
