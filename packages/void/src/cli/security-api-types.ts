import type { SecurityPickProblem } from '@void/platform/security-models';
/** Replies of the project security routes (spec §13.5), as the CLI reads them. */

/** `*_cap`: that cap is used up; `*_reserve`: one scan's worst case does not fit in what is left. */
export type SecurityBudgetCause =
  | 'project_cap'
  | 'platform_cap'
  | 'project_reserve'
  | 'platform_reserve';

export type SecurityScanSummary = {
  id: string;
  status: string;
  statusReason: string | null;
  failureCause: string | null;
  /** Which cap skipped a `skipped:budget` scan; older platforms do not send it. */
  budgetCause?: SecurityBudgetCause | null;
  refusalCategory: string | null;
  trigger: string;
  deploymentId: string | null;
  baseDeploymentId: string | null;
  coverageLabel: string | null;
  backlogFiles: number;
  filesScanned: number;
  model: string | null;
  meteredUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

/** Public request states that still hold the project protected. */
export const OPEN_PUBLIC_REQUEST_STATES: ReadonlySet<string> = new Set([
  'waiting_scan',
  'held_findings',
  'held_no_result',
  'needs_deploy',
]);

export type SecurityPublicRequest = {
  id: string;
  state: string;
  heldReason: string | null;
  targetDeploymentId: string;
  gateScanId: string | null;
  blockers: { count: number; ids: Array<string> };
};

export type SecurityUrgentFinding = {
  id: string;
  severity: string | null;
  title?: string;
  file?: string | null;
  line?: number | null;
  firstSeenAt?: string | null;
  notSeenInLatest?: boolean;
  possibleDuplicateOf?: {
    id: string;
    resolution: string | null;
    resolvedAt?: string | null;
  } | null;
};

export type ProjectSecurityStatus = {
  policy: { mode: string; applies: boolean; reason: string; publicGate: boolean };
  urgent: {
    count: number;
    counts: { critical: number; high: number };
    oldestFirstSeenAt: string | null;
    findings: Array<SecurityUrgentFinding>;
    more: number;
    detail: 'full' | 'counts';
  };
  model: {
    id: string | null;
    requested: string;
    source: 'project' | 'default' | 'fallback' | null;
    /** Why the project's own pick does not run; older platforms do not send it. */
    pickProblem?: SecurityPickProblem | null;
    thirdParty: boolean;
    noticeAccepted: boolean;
    pendingDefault: string | null;
  };
  budget: {
    capUsd: number | null;
    capSource: 'own' | 'limit' | 'none';
    ceilingUsd: number | null;
    /** Where `ceilingUsd` comes from; older platforms do not send it. */
    ceilingSource?: 'project' | 'plan' | 'default' | null;
    spentUsd: number;
    month: string;
    resetsAt: string;
    /** The most one scan with the current model can cost; older platforms do not send it. */
    scanReserveUsd?: number | null;
  } | null;
  lastScan: SecurityScanSummary | null;
  /**
   * The newest scan of another deployment than `lastScan`'s, not replaced by a newer
   * deploy; older platforms do not send it.
   */
  previousScan?: SecurityScanSummary | null;
  lastSuccessfulScan: SecurityScanSummary | null;
  deploysSinceLastSuccess: number | null;
  backlogFiles: number;
  counts: {
    open: Record<string, number>;
    leads: number;
    resolved: number;
    urgent: number;
  };
  publicRequest: SecurityPublicRequest | null;
  /** The caller may resolve findings (`settings`, a user session); older platforms do not send it. */
  canResolve?: boolean;
};

export type SecurityFinding = {
  id: string;
  verdict: string;
  severity: string | null;
  state: string;
  urgent: boolean;
  revision: number;
  title?: string;
  category?: string | null;
  cwe?: string | null;
  confidence?: string | number | null;
  file?: string | null;
  line?: number | null;
  lineEnd?: number | null;
  resolution?: string | null;
  /** `severity` was set by a person; `scanSeverity` is what the scans said. Newer platforms only. */
  severityEdited?: boolean;
  scanSeverity?: string | null;
  notSeenInLatest?: boolean;
  possibleDuplicateOf?: { id: string; resolution: string | null } | null;
  deploymentId?: string | null;
  firstSeenAt?: string | null;
  trace?: unknown;
  evidence?: unknown;
  conditions?: unknown;
  fix?: unknown;
  /** `runtime` when a request to a throwaway copy of the deployment proved it. */
  verdictSource?: 'static' | 'runtime' | null;
  runtimeProof?: { request: string; method: string; path: string; status: number } | null;
};

export type SecurityFindingEvent = {
  action: string;
  actorKind: string;
  actorRole: string | null;
  actor: string | null;
  /** The person is no longer the owner or a member of the project (older platforms omit it). */
  formerMember?: boolean;
  resolution: string | null;
  comment: string | null;
  /** `severity_edited` only: the severity before and after. */
  severityFrom?: string | null;
  severityTo?: string | null;
  createdAt: string | null;
};

export type SecurityFindingList = { findings: Array<SecurityFinding>; nextCursor: string | null };

export type SecurityFindingDetail = {
  finding: SecurityFinding;
  events?: Array<SecurityFindingEvent>;
};

export type SecurityFindingChange = {
  id: string;
  resolution: string | null;
  publicRequest?: SecurityPublicRequest;
};

/** `POST …/findings/:fid/severity`: the finding after a severity edit. */
export type SecuritySeverityChange = {
  id: string;
  severity: string | null;
  scanSeverity: string | null;
  severityEdited: boolean;
  changed: boolean;
  publicRequest?: SecurityPublicRequest;
};

export type SecurityScanList = { scans: Array<SecurityScanSummary>; nextCursor: string | null };

export type SecurityModelChange = { model: ProjectSecurityStatus['model'] };

/** `POST /projects/:id/security/scans` with `dryRun: true`: what a rescan would run. */
export type SecurityRescanPreview = {
  deploymentId: string;
  alreadyScanned: boolean;
  /** M31: the scan also reads client bundle sources; older platforms omit it. */
  clientAssets?: boolean;
  model: string | null;
  worstCaseUsd: number | null;
  budget: ProjectSecurityStatus['budget'];
};

export type SecurityRescanQueued = { scanId: string; deploymentId: string; clientAssets?: boolean };

export type SecurityBudgetChange = { budget: NonNullable<ProjectSecurityStatus['budget']> };

export type SecurityFindingQuery = {
  state: 'open' | 'resolved' | 'all';
  urgent: boolean;
  severity: string | null;
  limit: number;
  cursor: string | null;
};

/** M32: what a local check would run, before any code is sent. */
export type SecurityCheckPreview = {
  model: string;
  /** The provider notice, for a third-party model; `null` for a Cloudflare model. */
  notice: Array<string> | null;
  worstCaseUsd: number | null;
};

export type SecurityCheckCreated = {
  checkId: string;
  upload: { url: string; headers: Record<string, string> };
};

export type SecurityCheckFinding = {
  verdict: 'confirmed' | 'needs_validation';
  severity: string | null;
  title: string;
  file: string;
  lineStart: number | null;
};

export type SecurityCheckView = {
  check: SecurityScanSummary & { coverageNotes: Array<string> };
  ended: boolean;
  result: {
    version: 1;
    findings: Array<SecurityCheckFinding>;
    total: number;
    capped: boolean;
  } | null;
};
