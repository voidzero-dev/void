/** Replies of the project security routes (spec §13.5), as the CLI reads them. */

export type SecurityScanSummary = {
  id: string;
  status: string;
  statusReason: string | null;
  failureCause: string | null;
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

export type SecurityPublicRequest = {
  id: string;
  state: string;
  heldReason: string | null;
  targetDeploymentId: string;
  gateScanId: string | null;
  blockers: { count: number; ids: Array<string> };
  requestedAt: string;
  requestedByRole: string | null;
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
  } | null;
  lastScan: SecurityScanSummary | null;
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
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  notSeenInLatest?: boolean;
  possibleDuplicateOf?: { id: string; resolution: string | null } | null;
  reopenCount?: number;
  fixChecked?: boolean;
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
  resolution: string | null;
  comment: string | null;
  createdAt: string | null;
};

export type SecurityFindingList = { findings: Array<SecurityFinding>; nextCursor: string | null };

export type SecurityFindingDetail = {
  finding: SecurityFinding;
  events?: Array<SecurityFindingEvent>;
};

export type SecurityFindingChange = {
  ok: true;
  id: string;
  state: string;
  resolution: string | null;
  revision: number;
  publicRequest?: SecurityPublicRequest;
};

export type SecurityScanList = { scans: Array<SecurityScanSummary>; nextCursor: string | null };

export type SecurityModelChange = { ok: true; model: ProjectSecurityStatus['model'] };

/** `POST /projects/:id/security/scans` with `dryRun: true`: what a rescan would run. */
export type SecurityRescanPreview = {
  dryRun: true;
  deploymentId: string;
  alreadyScanned: boolean;
  tier: string;
  /** M31: the scan also reads client bundle sources; older platforms omit it. */
  clientAssets?: boolean;
  model: string | null;
  thirdParty: boolean;
  worstCaseUsd: number | null;
  budget: ProjectSecurityStatus['budget'];
};

export type SecurityRescanQueued = {
  ok: true;
  scanId: string;
  deploymentId: string;
  tier: string;
  clientAssets?: boolean;
  model: string | null;
  alreadyScanned: boolean;
};

export type SecurityBudgetChange = {
  ok: true;
  budget: NonNullable<ProjectSecurityStatus['budget']>;
};

export type SecurityFindingQuery = {
  state: 'open' | 'resolved' | 'all';
  urgent: boolean;
  severity: string | null;
  limit: number;
  cursor: string | null;
};
