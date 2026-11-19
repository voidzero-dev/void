// Tolerant reading of a model's report, used by the engines before the strict check
// in `validate-findings.ts`. Small models (glm-5.3 in spike S4) send the right facts in
// slightly wrong clothes: an enum in capitals, a field the schema does not have, a
// severity on a lead. This repairs those and nothing else; the strict validator still
// decides, and the API ingest uses the strict one only.

import { CONFIDENCES, RUN_STATUSES, SEVERITIES, VERDICTS } from './report.ts';
import {
  validateFindingsText,
  validateFindingsValue,
  type ValidationResult,
} from './validate-findings.ts';

const REPORT_KEYS = ['run_status', 'findings', 'notes'];
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
];
const TRACE_KEYS = ['file', 'line', 'note'];

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(object: Plain, keys: ReadonlyArray<string>): Plain {
  const out: Plain = {};
  for (const key of keys) {
    if (object[key] !== undefined) {
      out[key] = object[key];
    }
  }
  return out;
}

/** `High`, ` needs validation `, `needs-validation` → the enum spelling when it matches one. */
function enumValue(value: unknown, values: ReadonlyArray<string>): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const folded = value.trim().toLowerCase().split(' ').join('_').split('-').join('_');
  return values.includes(folded) ? folded : value;
}

/** A whole number written as a string or a float stays a number the validator accepts. */
function lineValue(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() !== '' && Number.isInteger(Number(value))) {
    return Number(value);
  }
  return value === 0 ? null : value;
}

export function coerceReport(value: unknown): unknown {
  if (!isPlain(value)) {
    return value;
  }
  const report = pick(value, REPORT_KEYS);
  report.run_status = enumValue(report.run_status, RUN_STATUSES);
  if (Array.isArray(report.findings)) {
    report.findings = report.findings.map(coerceFinding);
  }
  return report;
}

function coerceFinding(value: unknown): unknown {
  if (!isPlain(value)) {
    return value;
  }
  const finding = pick(value, FINDING_KEYS);
  finding.verdict = enumValue(finding.verdict, VERDICTS);
  finding.severity = enumValue(finding.severity, SEVERITIES);
  finding.confidence = enumValue(finding.confidence, CONFIDENCES);
  finding.line_start = lineValue(finding.line_start);
  finding.line_end = lineValue(finding.line_end);
  if (finding.verdict !== 'confirmed' && finding.severity !== undefined) {
    // A lead or a rejection carries no severity (spec §8.2).
    finding.severity = null;
  }
  if (Array.isArray(finding.trace)) {
    finding.trace = finding.trace.map((step) => {
      if (!isPlain(step)) {
        return step;
      }
      const out = pick(step, TRACE_KEYS);
      out.line = lineValue(out.line);
      return out;
    });
  }
  return finding;
}

/** Strict check after the repairs above. */
export function validateFindingsLenient(value: unknown): ValidationResult {
  return validateFindingsValue(coerceReport(value));
}

/** JSON text that holds a report: the whole text, a fenced block, or the outermost braces. */
export function jsonFromText(text: string): unknown {
  const trimmed = text.trim();
  const candidates: Array<string> = [trimmed];
  const fence = trimmed.indexOf('```');
  if (fence !== -1) {
    const bodyStart = trimmed.indexOf('\n', fence);
    const end = trimmed.indexOf('```', bodyStart === -1 ? fence + 3 : bodyStart);
    if (bodyStart !== -1 && end !== -1) {
      candidates.push(trimmed.slice(bodyStart + 1, end).trim());
    }
  }
  const open = trimmed.indexOf('{');
  const close = trimmed.lastIndexOf('}');
  if (open !== -1 && close > open) {
    candidates.push(trimmed.slice(open, close + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isPlain(parsed)) {
        return parsed;
      }
    } catch {
      // try the next shape
    }
  }
  return null;
}

/** The tool-call arguments as text: size and JSON checks as in the strict reader, then the repairs. */
export function validateFindingsTextLenient(text: string): ValidationResult {
  const strict = validateFindingsText(text);
  if (strict.ok || strict.kind === 'too_large' || strict.kind === 'not_json') {
    return strict;
  }
  return validateFindingsLenient(JSON.parse(text));
}
