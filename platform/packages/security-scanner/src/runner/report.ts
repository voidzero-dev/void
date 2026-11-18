// The findings report every engine hands back (`submit_findings` arguments, and
// `/scan/out/findings.json` with `schema_version`). `validate-findings.ts` checks it
// in the container, and the API reuses its `validateFindingsValue` at ingest (M12).

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERDICTS = ['confirmed', 'needs_validation', 'rejected'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const RUN_STATUSES = ['complete', 'incomplete'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const FINDINGS_SCHEMA_VERSION = 1;

export type TraceStep = {
  file: string;
  line: number | null;
  note: string;
};

export type FindingRecord = {
  fingerprint: string;
  verdict: Verdict;
  severity: Severity | null;
  confidence: Confidence | null;
  title: string;
  category: string;
  cwe: string | null;
  file: string;
  line_start: number | null;
  line_end: number | null;
  sink_path: string | null;
  outside_diff: boolean;
  trace: Array<TraceStep>;
  evidence: string;
  conditions: string;
  fix: string;
  reason: string;
};

export type ScanReport = {
  run_status: RunStatus;
  findings: Array<FindingRecord>;
  notes: string;
};

export type FindingsFile = ScanReport & { schema_version: typeof FINDINGS_SCHEMA_VERSION };

/** Limits shared by the validator, the prompts and the API copy. */
export const REPORT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRecords: 1000,
  fingerprint: 200,
  title: 200,
  category: 100,
  path: 1024,
  traceSteps: 30,
  traceNote: 500,
  evidence: 8000,
  conditions: 4000,
  fix: 4000,
  reason: 1000,
  notes: 2000,
  maxLine: 10_000_000,
} as const;

/** JSON Schema for the `submit_findings` tool, kept in step with the validator. */
export function submitFindingsParameters(): Record<string, unknown> {
  const path = { type: 'string', maxLength: REPORT_LIMITS.path };
  const line = { type: ['integer', 'null'], minimum: 1, maximum: REPORT_LIMITS.maxLine };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['run_status', 'findings'],
    properties: {
      run_status: { type: 'string', enum: [...RUN_STATUSES] },
      notes: { type: 'string', maxLength: REPORT_LIMITS.notes },
      findings: {
        type: 'array',
        maxItems: REPORT_LIMITS.maxRecords,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fingerprint', 'verdict', 'title', 'category', 'file'],
          properties: {
            fingerprint: { type: 'string', minLength: 1, maxLength: REPORT_LIMITS.fingerprint },
            verdict: { type: 'string', enum: [...VERDICTS] },
            severity: { type: ['string', 'null'], enum: [...SEVERITIES, null] },
            confidence: { type: ['string', 'null'], enum: [...CONFIDENCES, null] },
            title: { type: 'string', minLength: 1, maxLength: REPORT_LIMITS.title },
            category: { type: 'string', minLength: 1, maxLength: REPORT_LIMITS.category },
            cwe: { type: ['string', 'null'], description: 'CWE-<number> or null' },
            file: path,
            line_start: line,
            line_end: line,
            sink_path: { type: ['string', 'null'], maxLength: REPORT_LIMITS.path },
            outside_diff: { type: 'boolean' },
            trace: {
              type: 'array',
              maxItems: REPORT_LIMITS.traceSteps,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['file', 'note'],
                properties: {
                  file: path,
                  line,
                  note: { type: 'string', maxLength: REPORT_LIMITS.traceNote },
                },
              },
            },
            evidence: { type: 'string', maxLength: REPORT_LIMITS.evidence },
            conditions: { type: 'string', maxLength: REPORT_LIMITS.conditions },
            fix: { type: 'string', maxLength: REPORT_LIMITS.fix },
            reason: { type: 'string', maxLength: REPORT_LIMITS.reason },
          },
        },
      },
    },
  };
}
