/**
 * SARIF 2.1.0 export of security audit findings (design doc 0095, M31), for
 * `void project security list --format sarif` and `void platform security findings
 * --format sarif`. Code scanning tools (GitHub, editors) read it.
 *
 *   finding ─► result: rule = category, level from severity, file and lines,
 *              fingerprint = project + finding id, resolved ─► suppression
 *   categories ─► rules, with the highest `security-severity` of their results
 *
 * Paths are as the scan saw them: source paths from the repository or the source maps,
 * `_assets/…` for deployed static files, `_client/…` for client bundle sources and
 * `_worker/…` for built code with no source map.
 */
import { stripVTControlCharacters } from 'node:util';
import { hasOwnKey } from '../shared/has-own-key.ts';
import { getOwnVersion } from './agents.ts';

/** The CLI version for the SARIF tool entry; `null` when it cannot be read. */
export function sarifToolVersion(): string | null {
  try {
    const version: unknown = getOwnVersion();
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** Text from a model or a user: no escape sequences, one line. */
function cleanLine(value: unknown): string {
  let out = '';
  for (const char of stripVTControlCharacters(String(value ?? ''))) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
  }
  return out;
}

/** The fields of a finding the export reads; readers see only some of them. */
export type SarifFinding = Readonly<{
  id: string;
  /** The project slug; the operator export spans projects. */
  project?: string;
  verdict: string;
  severity: string | null;
  state: string;
  resolution?: string | null;
  urgent?: boolean;
  title?: string;
  category?: string | null;
  cwe?: string | null;
  file?: string | null;
  line?: number | null;
  lineEnd?: number | null;
  verdictSource?: 'static' | 'runtime' | null;
}>;

export const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';
const TOOL_NAME = 'Void Security Audit';
const TOOL_URI = 'https://void.cloud/guide/platform/administration/security-audits';
/** A finding a reader cannot see the details of has no category. */
const UNKNOWN_RULE = 'finding';

/** GitHub code scanning ranks by `security-severity` (0.1 to 10). */
const SECURITY_SEVERITY = {
  critical: 9.5,
  high: 8,
  medium: 5.5,
  low: 3,
  informational: 0.5,
};

function level(severity: string | null): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') {
    return 'error';
  }
  return severity === 'medium' ? 'warning' : 'note';
}

function positiveLine(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** A relative path as a SARIF URI: each segment percent-encoded, slashes kept. */
function fileUri(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region?: { startLine: number; endLine?: number };
  };
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations?: Array<SarifLocation>;
  partialFingerprints?: { 'voidFinding/v1': string };
  suppressions?: Array<{ kind: 'external'; status: 'accepted'; justification: string }>;
  properties?: {
    id: string;
    project?: string;
    severity: string | null;
    verdict: string;
    state: string;
    urgent?: boolean;
    cwe?: string;
  };
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  properties: { tags: Array<string>; 'security-severity'?: string };
}

/** One SARIF 2.1.0 log. */
export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: Array<{
    tool: {
      driver: { name: string; version?: string; informationUri: string; rules: Array<SarifRule> };
    };
    results: Array<SarifResult>;
  }>;
}

function result(finding: SarifFinding): SarifResult {
  const id = cleanLine(finding.id);
  const project = finding.project === undefined ? null : cleanLine(finding.project);
  const ruleId = finding.category ? cleanLine(finding.category) : UNKNOWN_RULE;
  const text =
    finding.title === undefined
      ? `${id}: ${cleanLine(finding.severity ?? 'unrated')} finding. Ask a project collaborator for the details.`
      : `${id}: ${cleanLine(finding.title)}`;
  const out: SarifResult = {
    ruleId,
    level: level(finding.severity),
    message: { text },
  };
  const file = finding.file ? fileUri(cleanLine(finding.file)) : '';
  if (file !== '') {
    const startLine = positiveLine(finding.line);
    const endLine = positiveLine(finding.lineEnd);
    out.locations = [
      {
        physicalLocation: {
          artifactLocation: { uri: file, uriBaseId: '%SRCROOT%' },
          ...(startLine === null
            ? {}
            : {
                region: {
                  startLine,
                  ...(endLine !== null && endLine >= startLine ? { endLine } : {}),
                },
              }),
        },
      },
    ];
  }
  // The finding id is stable across scans: code scanning keeps one alert per finding.
  out.partialFingerprints = { 'voidFinding/v1': project === null ? id : `${project}/${id}` };
  if (finding.state === 'resolved') {
    out.suppressions = [
      {
        kind: 'external',
        status: 'accepted',
        justification: cleanLine(finding.resolution ?? 'resolved')
          .split('_')
          .join(' '),
      },
    ];
  }
  out.properties = {
    id,
    ...(project === null ? {} : { project }),
    severity: finding.severity,
    verdict:
      finding.verdict === 'confirmed' && finding.verdictSource === 'runtime'
        ? 'confirmed (runtime)'
        : finding.verdict === 'needs_validation'
          ? 'lead'
          : cleanLine(finding.verdict),
    state: cleanLine(finding.state),
    ...(finding.urgent === undefined ? {} : { urgent: finding.urgent }),
    ...(finding.cwe ? { cwe: cleanLine(finding.cwe) } : {}),
  };
  return out;
}

/**
 * One SARIF log with one run. `version` is the CLI's; findings keep their order.
 */
export function securityFindingsSarif(
  findings: ReadonlyArray<SarifFinding>,
  options: Readonly<{ version: string | null }>,
): SarifLog {
  const results = findings.map(result);
  const rules = new Map<string, { id: string; score: number; cwes: Set<string> }>();
  for (const [index, finding] of findings.entries()) {
    const ruleId = results[index].ruleId;
    const rule = rules.get(ruleId) ?? { id: ruleId, score: 0, cwes: new Set<string>() };
    const severity = finding.severity;
    rule.score = Math.max(
      rule.score,
      severity !== null && hasOwnKey(SECURITY_SEVERITY, severity) ? SECURITY_SEVERITY[severity] : 0,
    );
    if (finding.cwe) {
      rule.cwes.add(cleanLine(finding.cwe));
    }
    rules.set(ruleId, rule);
  }
  return {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            ...(options.version ? { version: options.version } : {}),
            informationUri: TOOL_URI,
            rules: [...rules.values()].map((rule) => ({
              id: rule.id,
              shortDescription: {
                text: rule.id === UNKNOWN_RULE ? 'Security finding' : rule.id.split('-').join(' '),
              },
              properties: {
                tags: ['security', ...rule.cwes],
                ...(rule.score > 0 ? { 'security-severity': rule.score.toFixed(1) } : {}),
              },
            })),
          },
        },
        results,
      },
    ],
  };
}
