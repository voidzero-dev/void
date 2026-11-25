import { securityPickProblemNote } from '@void/platform/security-models';
import { securityTraceLines } from '@void/platform/security-policy';
import { confirm, isCancel } from '@voidzero-dev/vite-plus-prompts';
import { isCI } from 'ci-info';
import { hasOwnKey } from '../shared/has-own-key.ts';
import { getToken, openBrowser } from './auth.ts';
import { PlatformApiError, PlatformClient } from './client.ts';
import { cleanBlock, cleanLine } from './output.ts';
import type { ProjectSecurityArgs } from './project-security-args.ts';
import {
  checkEndedWithResult,
  checkFailureMessage,
  checkResultLines,
  checkSummaryLines,
  collectSecurityLocalTree,
  packSecurityLocalTree,
  sendSecurityLocalCheck,
  waitForSecurityLocalCheck,
} from './project-security-check.ts';
import type { SecurityCheckDeps } from './project-security-check.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, requireProjectBySlug } from './resolve-project.ts';
import type {
  ProjectSecurityStatus,
  SecurityBudgetCause,
  SecurityFinding,
  SecurityFindingEvent,
  SecurityPublicRequest,
  SecurityRescanPreview,
  SecurityScanSummary,
} from './security-api-types.ts';
import { sarifToolVersion, securityFindingsSarif } from './security-sarif.ts';

type Args = ProjectSecurityArgs;

export const usd = (value: number) => `$${value.toFixed(2)}`;

export function day(iso: string | null | undefined): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time)
    ? '-'
    : new Date(time).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
}

function stamp(iso: string | null | undefined): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time)
    ? '-'
    : `${day(iso)}, ${new Date(time).toISOString().slice(11, 16)} UTC`;
}

function duration(scan: SecurityScanSummary): string | null {
  const start = scan.startedAt ? Date.parse(scan.startedAt) : Number.NaN;
  const end = scan.finishedAt ? Date.parse(scan.finishedAt) : Number.NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  const minutes = Math.round((end - start) / 60_000);
  return minutes < 1
    ? '<1 min'
    : minutes < 60
      ? `${minutes} min`
      : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

type Budget = NonNullable<ProjectSecurityStatus['budget']>;

const BUDGET_CAUSES: ReadonlyArray<SecurityBudgetCause> = [
  'project_cap',
  'platform_cap',
  'project_reserve',
  'platform_reserve',
];

/**
 * Which cap skipped a scan. Older platforms send no cause: a project cap whose spend
 * reached it is the project's, anything else the platform's.
 */
export function budgetCause(
  scan: Pick<SecurityScanSummary, 'budgetCause'> | null | undefined,
  budget: Budget | null | undefined,
): SecurityBudgetCause {
  const sent = BUDGET_CAUSES.find((cause) => cause === scan?.budgetCause);
  if (sent) {
    return sent;
  }
  return budget && budget.capUsd !== null && budget.spentUsd >= budget.capUsd
    ? 'project_cap'
    : 'platform_cap';
}

/** What a used-up project cap will refuse at the next scan start, if anything (spec §6.5). */
export function budgetAhead(budget: Budget | null | undefined): SecurityBudgetCause | null {
  if (!budget || budget.capUsd === null) {
    return null;
  }
  if (budget.spentUsd >= budget.capUsd) {
    return 'project_cap';
  }
  const reserve = budget.scanReserveUsd;
  return typeof reserve === 'number' && budget.spentUsd + reserve > budget.capUsd
    ? 'project_reserve'
    : null;
}

/** A CLI `--usd` value: `150`, or `150.50` with cents. */
function usdArgument(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** The one §16.3 raise line that works now for this project's cap. */
function projectRaiseLine(budget: Budget, projectId: string | undefined): string {
  const cap = budget.capUsd ?? 0;
  const ceiling = budget.ceilingUsd;
  if (budget.capSource === 'own' && (ceiling === null || cap < ceiling)) {
    return ceiling === null
      ? 'A project admin can raise it: void project security budget --usd <amount>'
      : `A project admin can raise it (up to ${usd(ceiling)}): void project security budget --usd ${usdArgument(ceiling)}`;
  }
  // The operator route takes the project id, not the slug.
  const id = projectId ? cleanLine(projectId) : '<project-id>';
  return `Your platform admin can raise it: void platform security budget --project ${id} --usd ${usdArgument(Math.max(1, Math.ceil(cap * 1.5)))}`;
}

/** The parts of the §11.4 / §16.3 copy for a scan the budget skipped. */
export type BudgetSkipCopy = {
  /** What happened, with no end stop: `this project's monthly scan budget is used up ($40.00 of $40.00)`. */
  why: string;
  /** `Resets Dec 1.` while the cap is still used up. */
  resets: string | null;
  /** The one way on that works now; `null` for the platform cap and for readers. */
  next: string | null;
  /** The cap was raised or removed since, so the next scan can run. */
  raised: boolean;
};

export function budgetSkipCopy(
  cause: SecurityBudgetCause,
  budget: Budget | null | undefined,
  model: string | null | undefined,
  projectId?: string,
): BudgetSkipCopy {
  const none = { resets: null, next: null, raised: false };
  if (!budget) {
    // Readers see no amounts (spec §16.3).
    return { ...none, why: 'the monthly scan budget is used up' };
  }
  const resets = `Resets ${day(budget.resetsAt)}.`;
  const reserve = typeof budget.scanReserveUsd === 'number' ? budget.scanReserveUsd : null;
  // `one scan with <model> can cost up to $2.04, more than is left of …`
  const oneScan = `one scan with ${cleanLine(model ?? 'this model')} can cost${reserve === null ? '' : ` up to ${usd(reserve)},`}`;
  const cheaper = 'pick a cheaper model: void project security model';
  if (cause === 'platform_cap') {
    return { ...none, why: "the platform's monthly scan budget is used up", resets };
  }
  if (cause === 'platform_reserve') {
    return {
      ...none,
      why: `${oneScan} more than is left of the platform's monthly scan budget`,
      next: `Ask your platform admin, or ${cheaper}`,
    };
  }
  const cap = budget.capUsd;
  const usedUp = cause === 'project_cap' ? 'was used up' : 'had too little left for one scan';
  if (cap === null) {
    return {
      ...none,
      why: `this project's monthly scan budget ${usedUp}; the cap was removed since`,
      raised: true,
    };
  }
  const left = cap - budget.spentUsd;
  const fits = cause === 'project_cap' ? left > 0 : reserve !== null && reserve <= left;
  if (fits) {
    return {
      ...none,
      why: `this project's monthly scan budget ${usedUp}; it was raised since (${usd(budget.spentUsd)} of ${usd(cap)} used)`,
      raised: true,
    };
  }
  if (cause === 'project_reserve') {
    return {
      ...none,
      why: `${oneScan} more than is left of this project's monthly scan budget (${usd(Math.max(0, left))} of ${usd(cap)})`,
      next: `${projectRaiseLine(budget, projectId)}. Or ${cheaper}`,
    };
  }
  return {
    ...none,
    why: `this project's monthly scan budget is used up (${usd(budget.spentUsd)} of ${usd(cap)})`,
    resets,
    next: projectRaiseLine(budget, projectId),
  };
}

/** `2 critical, 1 high`. */
export function urgentCounts(urgent: ProjectSecurityStatus['urgent']): string {
  const { critical, high } = urgent.counts;
  return [critical ? `${critical} critical` : '', high ? `${high} high` : '']
    .filter(Boolean)
    .join(', ');
}

const row = (label: string, text: string) => `  ${label.padEnd(10)} ${text}`;
const cont = (text: string) => `  ${' '.repeat(10)} ${text}`;

const MODEL_SOURCES = {
  project: "your project's pick",
  default: 'platform default',
  fallback: 'fallback: the model you asked for cannot run now',
};

/** Where the model in use comes from; names the pick and why it does not run (spec §8.2). */
function modelSource(model: ProjectSecurityStatus['model']): string {
  if (model.pickProblem) {
    return cleanLine(securityPickProblemNote(model.requested, model.pickProblem));
  }
  // A source a newer platform added reads like none.
  return model.source !== null && hasOwnKey(MODEL_SOURCES, model.source)
    ? MODEL_SOURCES[model.source]
    : 'no model can run now';
}

/** Spec §11.4 status copy for the last scan; `null` when the scan needs no explanation. */
export function scanStatusCopy(status: ProjectSecurityStatus, projectId?: string): string | null {
  const { lastScan, lastSuccessfulScan, budget } = status;
  if (!lastScan) {
    return null;
  }
  const since = lastSuccessfulScan?.deploymentId ?? null;
  const next = since
    ? `The next scan covers changes since ${since}.`
    : 'The next scan reviews the whole app.';
  const reason = cleanLine(lastScan.statusReason ?? 'unknown');
  switch (lastScan.status) {
    case 'queued':
    case 'running':
    case 'pending_input':
      return 'Last security scan still running. Results show here when it ends.';
    case 'failed':
      return lastScan.failureCause === 'installation'
        ? 'Not scanned: a platform problem (your platform admin can see it in the admin panel).'
        : `Last scan failed (${reason}). ${next}`;
    case 'timed_out':
      return `Last scan failed (timed out). ${next}`;
    case 'refused':
      return `Refused by ${cleanLine(lastScan.model ?? 'the scan model')} (category: ${cleanLine(
        lastScan.refusalCategory ?? 'unknown',
      )}). The next deploy is scanned again. To switch model: void project security model <id>`;
    case 'incomplete':
      return reason.startsWith('budget')
        ? `Last scan stopped early: the monthly scan budget ran out. Confirmed findings it found are kept. ${next}`
        : `Last scan was partial (${reason}). Confirmed findings it found are kept. ${next}`;
    case 'superseded':
      return 'Replaced by the scan of a newer deploy.';
    case 'canceled':
      return `Canceled by a platform admin. ${next}`;
    case 'skipped':
      if (reason === 'budget') {
        const cause = budgetCause(lastScan, budget);
        const copy = budgetSkipCopy(cause, budget, status.model?.id, projectId);
        if (copy.raised) {
          return `Not scanned: ${copy.why}. The next deploy is scanned.`;
        }
        const next =
          cause === 'platform_cap' && budget ? 'Your platform admin can raise it.' : copy.next;
        return [`Not scanned: ${copy.why}.`, copy.resets, next ? withStop(next) : null]
          .filter(Boolean)
          .join(' ');
      }
      if (reason === 'backlog') {
        return `Not scanned: the scan queue was full for 24 h. ${next}`;
      }
      if (reason === 'protected') {
        return 'Not scanned: this project is protected by Zero Trust and the platform scans public projects only.';
      }
      if (reason === 'project_policy') {
        return 'Not scanned: a platform admin turned scans off for this project.';
      }
      return `Not scanned (${reason}).`;
    default:
      return null;
  }
}

const HELD_CAUSES = {
  refused: 'refused',
  timed_out: 'timed out',
  findings_capped: 'it hit the findings limit, so more findings may be hidden',
  failed_project: 'the scan of this project failed',
};

function withStop(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/**
 * What the public request copy reads besides the request: the backlog, the budget, and
 * (when known) the gate scan, the model and the project id for the raise line.
 */
export type RequestSecurity = Pick<ProjectSecurityStatus, 'backlogFiles' | 'budget'> &
  Partial<Pick<ProjectSecurityStatus, 'lastScan' | 'model'>> & { projectId?: string };

/** Spec §11.4 public request copy, with the command that moves it on. */
export function publicRequestLines(
  slug: string,
  request: SecurityPublicRequest,
  status: RequestSecurity,
): Array<string> {
  const ids = request.blockers.ids.map(cleanLine).join(', ');
  const target = cleanLine(request.targetDeploymentId);
  const bypass = 'void project zero-trust bypass --reason "…"';
  const reason = request.heldReason;
  const lines: Array<string> = [];
  switch (request.state) {
    case 'waiting_scan':
      // Same rule as the platform copy: say what the request waits for.
      lines.push(
        reason === 'deployment_moving'
          ? `Waiting for the new deployment to go live before ${slug} goes public. It stays protected by Zero Trust until the scan of that deployment passes.`
          : reason === 'zero_trust_not_ready'
            ? `Waiting for the Zero Trust protection of ${slug} to be ready before it goes public. It stays protected until then.`
            : status.backlogFiles > 0
              ? `Scanning in parts: ${status.backlogFiles} files left. ${slug} stays protected until every file is scanned.`
              : `Waiting for a security scan of ${target} before ${slug} goes public. It stays protected by Zero Trust until the scan passes.`,
      );
      break;
    case 'held_findings': {
      const count = request.blockers.ids.length;
      lines.push(
        `Stays protected: ${count} urgent ${count === 1 ? 'finding' : 'findings'} must be resolved before Zero Trust is turned off (${ids}). Resolve each one as fixed (then deploy the fix), or as false-positive or accepted-risk with a comment; then the request unlocks.`,
        '→ void project security list --urgent',
      );
      break;
    }
    case 'needs_deploy':
      lines.push(
        reason === 'unproven_fix'
          ? `Stays protected: ${ids} ${request.blockers.ids.length === 1 ? 'was' : 'were'} resolved as fixed. Deploy the fix (if it is already live, deploy again); ${slug} goes public when the scan of that deploy is clean.`
          : `Stays protected: the live deployment ${target} cannot be scanned (its code was not kept for scanning). Deploy again; that deploy is scanned before ${slug} goes public.`,
        `Or bypass the scan: ${bypass}`,
      );
      break;
    case 'held_no_result': {
      if (reason === 'unread_files') {
        // Asking again scans the same code: it does not help.
        lines.push(
          `Stays protected: the security scan could not read some project files (too large, not text, or a path the scanner cannot send). Fix them and deploy again, or bypass the scan: ${bypass}`,
        );
      } else if (reason === 'failed_installation') {
        lines.push(
          `Stays protected: the security scan could not run (a platform problem; your platform admin can see it). A project admin or owner can bypass the scan: ${bypass}`,
        );
      } else if (reason === 'skipped_budget') {
        const gate =
          status.lastScan && status.lastScan.id === request.gateScanId ? status.lastScan : null;
        const cause = budgetCause(gate, status.budget);
        const copy = budgetSkipCopy(cause, status.budget, status.model?.id, status.projectId);
        const resets = copy.resets ? ` ${copy.resets}` : '';
        if (copy.raised) {
          lines.push(
            `Stays protected: ${copy.why}, so the scan could not run. Ask again with void project zero-trust public, or bypass the scan: ${bypass}`,
          );
        } else if (copy.next === null) {
          lines.push(
            `Stays protected: ${copy.why}, so the scan could not run.${resets} Ask your platform admin, or bypass the scan: ${bypass}`,
          );
        } else {
          lines.push(
            `Stays protected: ${copy.why}, so the scan could not run.${resets} ${withStop(copy.next)}`,
            `Or bypass the scan: ${bypass}`,
          );
        }
      } else {
        const cause =
          reason !== null && hasOwnKey(HELD_CAUSES, reason)
            ? HELD_CAUSES[reason]
            : cleanLine((reason ?? 'no result').split('_').join(' '));
        lines.push(
          `Stays protected: the security scan did not finish (${cause}). Ask again with void project zero-trust public, deploy again, or bypass the scan: ${bypass}`,
        );
        if (reason === 'refused') {
          lines.push('To switch model: void project security model <id>, then ask again.');
        }
      }
      break;
    }
    case 'passed':
      lines.push(
        `Security scan passed (nothing urgent found). Zero Trust is being turned off for ${slug}.`,
      );
      break;
    case 'bypassed':
      lines.push(
        'Public without a clean scan: a project admin bypassed the scan. Your platform admins were told.',
      );
      break;
    default:
      lines.push(`Public request canceled. ${slug} stays protected.`);
  }
  return lines;
}

export function formatStatus(
  slug: string,
  status: ProjectSecurityStatus,
  projectId?: string,
): Array<string> {
  const lines = [`${slug} · security`];
  const { urgent, policy, model, budget, lastScan, lastSuccessfulScan, counts } = status;
  if (urgent.count === 0) {
    lines.push(row('Urgent', 'none open'));
  } else {
    lines.push(
      row(
        'Urgent',
        `${urgent.count} open (${urgentCounts(urgent)}) · oldest ${day(urgent.oldestFirstSeenAt)}  → void project security list --urgent`,
      ),
    );
  }
  const reason = cleanLine(policy.reason);
  if (policy.mode === 'disabled') {
    lines.push(row('Policy', reason));
  } else if (policy.applies) {
    lines.push(
      row(
        'Policy',
        `applies: ${reason}${policy.mode === 'public' ? ' (Public projects only)' : ''}`,
      ),
    );
  } else {
    lines.push(row('Policy', `does not apply: ${reason}`));
  }
  lines.push(row('Model', `${cleanLine(model.id ?? 'none')} (${modelSource(model)})`));
  if (model.thirdParty && model.id) {
    lines.push(
      cont(
        'Run by a third-party provider, not Cloudflare. Its usage policy applies and it may refuse.',
      ),
    );
  }
  if (model.pendingDefault) {
    lines.push(
      cont(
        `The platform default ${cleanLine(model.pendingDefault)} waits for the provider notice: void project security model --default --accept-provider-notice`,
      ),
    );
  }
  if (budget) {
    const origin = budget.capSource === 'own' ? 'project cap' : 'platform limit';
    lines.push(
      row(
        'Budget',
        budget.capUsd === null
          ? `${usd(budget.spentUsd)} this month · no cap`
          : `${usd(budget.spentUsd)} of ${usd(budget.capUsd)} this month (${origin}) · resets ${day(budget.resetsAt)}`,
      ),
    );
  }
  if (!lastScan) {
    // The "first scan runs after your next deploy" promise holds only when the policy applies.
    lines.push(
      row(
        'Last scan',
        policy.applies && policy.mode !== 'disabled'
          ? 'none yet. The first scan runs after your next deploy and reviews the whole app.'
          : 'none',
      ),
    );
  } else {
    const parts = [
      cleanLine(lastScan.status + (lastScan.statusReason ? ` (${lastScan.statusReason})` : '')),
      lastScan.deploymentId ? cleanLine(lastScan.deploymentId) : null,
      duration(lastScan),
      lastScan.coverageLabel ? cleanLine(lastScan.coverageLabel) : null,
    ].filter(Boolean);
    lines.push(row('Last scan', parts.join(' · ')));
  }
  if (lastSuccessfulScan?.deploymentId) {
    const since = status.deploysSinceLastSuccess;
    lines.push(
      row(
        'Last good',
        `${cleanLine(lastSuccessfulScan.deploymentId)}${since === null ? '' : ` (${since} ${since === 1 ? 'deploy' : 'deploys'} ago)`}`,
      ),
    );
  }
  if (status.backlogFiles > 0) {
    lines.push(row('Backlog', `${status.backlogFiles} files not scanned yet`));
  }
  const copy = scanStatusCopy(status, projectId);
  if (copy) {
    lines.push(row('Note', copy));
  }
  const other =
    (counts.open.medium ?? 0) + (counts.open.low ?? 0) + (counts.open.informational ?? 0);
  lines.push(row('Open', `${counts.urgent} urgent · ${other} other · ${counts.leads} leads`));
  if (status.publicRequest) {
    const [first = '', ...rest] = publicRequestLines(slug, status.publicRequest, {
      ...status,
      projectId,
    });
    lines.push(row('Public', first), ...rest.map(cont));
  }
  return lines;
}

function findingState(finding: SecurityFinding): string {
  if (finding.state === 'resolved') {
    return finding.resolution
      ? `resolved (${cleanLine(finding.resolution).split('_').join('-')})`
      : 'resolved';
  }
  return finding.verdict === 'needs_validation' ? 'lead' : 'open';
}

export function formatFindingList(findings: Array<SecurityFinding>): Array<string> {
  return findings.map((finding) => {
    const place = finding.file
      ? `${cleanLine(finding.file)}${finding.line ? `:${finding.line}` : ''}`
      : '';
    return [
      cleanLine(finding.id).padEnd(7),
      cleanLine(finding.severity ?? '-').padEnd(14),
      findingState(finding).padEnd(26),
      finding.title === undefined ? '' : cleanLine(finding.title),
      place ? `(${place})` : '',
    ]
      .join(' ')
      .trimEnd();
  });
}

function indent(text: string): Array<string> {
  return cleanBlock(text)
    .split('\n')
    .map((line) => `    ${line}`);
}

export function formatFinding(
  finding: SecurityFinding,
  events: Array<SecurityFindingEvent> | undefined,
): Array<string> {
  const lines = [
    `${cleanLine(finding.id)}  ${cleanLine(finding.severity ?? '-')}  ${findingState(finding)}${finding.urgent ? '  (urgent)' : ''}`,
  ];
  if (finding.title === undefined) {
    lines.push(
      '  Readers see the id, severity and state of open findings. Ask a project collaborator for the details.',
    );
    return lines;
  }
  lines.push(`  ${cleanLine(finding.title)}`);
  const meta = [
    finding.file ? `${cleanLine(finding.file)}${finding.line ? `:${finding.line}` : ''}` : null,
    finding.category ? cleanLine(finding.category) : null,
    finding.cwe ? cleanLine(finding.cwe) : null,
    finding.verdictSource === 'runtime' ? 'confirmed (runtime)' : null,
    finding.confidence !== undefined && finding.confidence !== null
      ? `confidence ${cleanLine(finding.confidence)}`
      : null,
    finding.deploymentId ? `first seen in ${cleanLine(finding.deploymentId)}` : null,
    finding.firstSeenAt ? day(finding.firstSeenAt) : null,
  ].filter(Boolean);
  if (meta.length > 0) {
    lines.push(`  ${meta.join(' · ')}`);
  }
  if (finding.severityEdited) {
    lines.push(
      `  Severity set by a person${finding.scanSeverity ? ` (scans said ${cleanLine(finding.scanSeverity)})` : ''}.`,
    );
  }
  if (finding.notSeenInLatest) {
    lines.push('  Not seen in the latest scan.');
  }
  if (finding.possibleDuplicateOf) {
    lines.push(`  Possible duplicate of ${cleanLine(finding.possibleDuplicateOf.id)}.`);
  }
  for (const [label, value] of [
    ['Trace', securityTraceLines(finding.trace)?.map(cleanLine).join('\n') ?? finding.trace],
    ['Evidence', finding.evidence],
    [
      'Runtime proof',
      finding.runtimeProof
        ? `${cleanLine(finding.runtimeProof.method)} ${cleanLine(finding.runtimeProof.path)} answered ${finding.runtimeProof.status} on a throwaway copy`
        : null,
    ],
    ['Conditions', finding.conditions],
    ['Suggested fix', finding.fix],
  ] as const) {
    if (value !== null && value !== undefined && value !== '') {
      lines.push(
        '',
        `  ${label}`,
        ...indent(typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
      );
    }
  }
  if (events && events.length > 0) {
    lines.push('', '  History');
    for (const event of events) {
      const who = event.actor ?? event.actorKind;
      // Spec #24: a removed commenter keeps the comment, shown as a former member.
      const role = event.formerMember
        ? 'former member'
        : event.actorRole
          ? cleanLine(event.actorRole)
          : null;
      lines.push(
        `    ${stamp(event.createdAt)} · ${cleanLine(event.action)}${event.resolution ? ` (${cleanLine(event.resolution).split('_').join('-')})` : ''}${event.severityFrom && event.severityTo ? ` (${cleanLine(event.severityFrom)} → ${cleanLine(event.severityTo)})` : ''} · ${cleanLine(who)}${role ? ` (${role})` : ''}`,
      );
      if (event.comment) {
        lines.push(...indent(event.comment).map((line) => `  ${line}`));
      }
    }
  }
  return lines;
}

export function formatScans(scans: Array<SecurityScanSummary>): Array<string> {
  return scans.map((scan) =>
    [
      day(scan.createdAt).padEnd(7),
      cleanLine(scan.status + (scan.statusReason ? ` (${scan.statusReason})` : '')).padEnd(24),
      cleanLine(scan.deploymentId ?? '-').padEnd(12),
      cleanLine(scan.trigger).padEnd(9),
      duration(scan) ?? '-',
      scan.meteredUsd === null ? '' : usd(scan.meteredUsd),
      scan.model ? cleanLine(scan.model) : '',
    ]
      .join(' ')
      .trimEnd(),
  );
}

export async function resolveTarget(
  root: string,
  args: { projectSlug: string },
): Promise<{ client: PlatformClient; projectId: string; slug: string }> {
  const token = getToken(root);
  if (!token) {
    throw new Error('project: Not logged in. Run `void account login` first.');
  }
  const client = new PlatformClient(token, { root });
  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectSlug });
  if (requestedSlug) {
    const project = await requireProjectBySlug(client, requestedSlug);
    return { client, projectId: project.projectId, slug: project.slug };
  }
  const linked = readProjectConfig(root);
  if (!linked) {
    throw new Error('project: No linked project. Pass --project <name> or set VOID_PROJECT.');
  }
  return { client, projectId: linked.projectId, slug: linked.slug };
}

function print(args: Args, value: unknown, lines: Array<string>): void {
  if (args.json) {
    console.log(JSON.stringify(value));
  } else {
    console.log(['', ...lines, ''].join('\n'));
  }
}

function reasonLabel(reason: string | null): string {
  return (reason ?? 'resolved').split('_').join(' ');
}

function noticeOf(error: unknown): { version: number; notice: Array<string> } | null {
  if (!(error instanceof PlatformApiError) || error.status !== 422) {
    return null;
  }
  try {
    const body = JSON.parse(error.body) as { error?: unknown; version?: unknown; notice?: unknown };
    if (body.error !== 'provider notice not accepted' || typeof body.version !== 'number') {
      return null;
    }
    const notice = Array.isArray(body.notice)
      ? body.notice.filter((x): x is string => typeof x === 'string')
      : [];
    return { version: body.version, notice };
  } catch {
    return null;
  }
}

function severityChangeLine(
  id: string,
  level: string,
  result: Readonly<{ changed: boolean; severityEdited: boolean; scanSeverity: string | null }>,
): string {
  if (!result.changed) {
    return result.severityEdited
      ? `${id} is already ${level}. Nothing changed.`
      : `${id} already uses the scan severity (${level}). Nothing changed.`;
  }
  if (!result.severityEdited) {
    return `✓ ${id} uses the scan severity again: ${level}.`;
  }
  const scans = result.scanSeverity ? cleanLine(result.scanSeverity) : null;
  return `✓ ${id} severity set to ${level}${scans && scans !== level ? ` (scans said ${scans})` : ''}. Later scans keep it.`;
}

export type ProjectSecurityDeps = {
  openUrl?: (url: string) => void;
  interactive?: boolean;
  confirm?: (message: string) => Promise<boolean>;
  /** M32 local check: poll timing, the upload fetch, the file list. */
  check?: SecurityCheckDeps;
};

/** The rescan cost confirm (spec §13.4 rescan rule): what it runs and what it can cost. */
export function rescanConfirmLines(preview: SecurityRescanPreview): Array<string> {
  const id = cleanLine(preview.deploymentId);
  const model = cleanLine(preview.model ?? 'the scan model');
  const cost =
    typeof preview.worstCaseUsd === 'number'
      ? ` It can cost up to ${usd(preview.worstCaseUsd)}.`
      : '';
  const whole = preview.clientAssets
    ? 'This reviews the whole app, and the sources of its client bundles.'
    : 'This reviews the whole app.';
  const lines = [
    preview.alreadyScanned
      ? `Live deployment ${id} was already scanned. Run a full scan with ${model}? ${whole}${cost}`
      : `Run a full scan of live deployment ${id} with ${model}? ${whole}${cost}`,
  ];
  const budget = preview.budget;
  lines.push(
    budget && budget.capUsd !== null
      ? `Monthly caps apply: ${usd(budget.spentUsd)} of ${usd(budget.capUsd)} spent this month.`
      : 'Monthly caps apply when the scan starts.',
  );
  return lines;
}

export async function runProjectSecurityCommand(
  root: string,
  args: Args,
  deps: ProjectSecurityDeps = {},
): Promise<void> {
  const { client, projectId, slug } = await resolveTarget(root, args);

  if (args.action === 'status') {
    const status = await client.getProjectSecurity(projectId);
    print(args, status, formatStatus(slug, status, projectId));
    return;
  }

  if (args.action === 'list') {
    const found: Array<SecurityFinding> = [];
    let cursor: string | null = null;
    let more = false;
    for (;;) {
      const page = await client.listProjectSecurityFindings(projectId, {
        state: args.state,
        urgent: args.urgent,
        severity: args.severity,
        limit: 100,
        cursor,
      });
      found.push(...page.findings);
      cursor = page.nextCursor;
      if (!cursor) {
        break;
      }
      if (found.length >= 500) {
        more = true;
        break;
      }
    }
    const shown = args.leads
      ? found
      : found.filter((finding) => finding.verdict !== 'needs_validation');
    const hidden = found.length - shown.length;
    if (args.format === 'sarif') {
      // stdout holds the SARIF log only; what it leaves out goes to stderr.
      console.log(
        JSON.stringify(securityFindingsSarif(shown, { version: sarifToolVersion() }), null, 2),
      );
      if (hidden > 0) {
        console.error(
          `${hidden} ${hidden === 1 ? 'lead is' : 'leads are'} left out. Add them with --leads.`,
        );
      }
      if (more) {
        console.error(
          'Only the first 500 findings are in the file. Narrow it with --severity or --urgent.',
        );
      }
      return;
    }
    const lines = shown.length === 0 ? ['No findings.'] : formatFindingList(shown);
    if (hidden > 0) {
      lines.push(
        `${hidden} ${hidden === 1 ? 'lead is' : 'leads are'} hidden. Show them with --leads.`,
      );
    }
    if (more) {
      lines.push('Showing the first 500. Narrow the list with --severity or --urgent.');
    }
    print(args, { findings: shown, more }, lines);
    return;
  }

  if (args.action === 'show') {
    const detail = await client.getProjectSecurityFinding(projectId, args.id);
    print(args, detail, formatFinding(detail.finding, detail.events));
    return;
  }

  if (args.action === 'comment') {
    const result = await client.commentOnProjectSecurityFinding(projectId, args.id, args.text);
    print(args, result, [`✓ Comment added to ${cleanLine(result.id)}.`]);
    return;
  }

  const revision = async (id: string) =>
    (await client.getProjectSecurityFinding(projectId, id)).finding.revision;

  if (args.action === 'reopen') {
    const result = await client.reopenProjectSecurityFinding(projectId, args.id, {
      comment: args.comment,
      expectedRevision: await revision(args.id),
    });
    print(args, result, [`✓ ${cleanLine(result.id)} reopened.`]);
    return;
  }

  if (args.action === 'severity') {
    const result = await client.editProjectSecurityFindingSeverity(projectId, args.id, {
      severity: args.severity,
      comment: args.comment,
      expectedRevision: await revision(args.id),
    });
    const id = cleanLine(result.id);
    const level = cleanLine(result.severity ?? '-');
    const lines = [severityChangeLine(id, level, result)];
    if (result.publicRequest) {
      const status = await statusAfterChange(client, projectId);
      const [first = '', ...rest] = publicRequestLines(slug, result.publicRequest, {
        ...(status ?? { backlogFiles: 0, budget: null }),
        projectId,
      });
      lines.push(`  Public request: ${first}`, ...rest.map((line) => `  ${line}`));
    }
    print(args, result, lines);
    return;
  }

  if (args.action === 'resolve') {
    const results: Array<Record<string, unknown>> = [];
    const lines: Array<string> = [];
    let lastRequest: SecurityPublicRequest | undefined;
    let failed = 0;
    for (const id of args.ids) {
      try {
        const result = await client.resolveProjectSecurityFinding(projectId, id, {
          reason: args.reason,
          comment: args.comment,
          expectedRevision: await revision(id),
        });
        results.push(result);
        lastRequest = result.publicRequest ?? lastRequest;
        lines.push(
          `✓ ${cleanLine(result.id)} resolved (${reasonLabel(result.resolution)}).${args.reason === 'fixed' ? ' The next scan will check that the fix holds.' : ''}`,
        );
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        results.push({ ok: false, id, error: message });
        lines.push(`✖ ${id}: ${cleanLine(message)}`);
      }
    }
    if (failed < args.ids.length) {
      const status = await statusAfterChange(client, projectId);
      const open = status?.urgent.findings ?? [];
      const describe = (id: string) => {
        const found = open.find((finding) => finding.id === id);
        return found?.severity ? `${id} (${cleanLine(found.severity)})` : id;
      };
      if (lastRequest?.state === 'held_findings') {
        lines.push(
          `  Public request: still held by ${lastRequest.blockers.ids.map(describe).join(', ')}.`,
        );
      } else if (lastRequest?.state === 'needs_deploy') {
        lines.push(
          `  Public request: deploy the fix. ${slug} goes public when the scan of that deploy is clean.`,
        );
      } else if (lastRequest?.state === 'waiting_scan') {
        lines.push('  Public request: waiting for a security scan.');
      } else if (status && status.urgent.count > 0) {
        lines.push(
          `  Still open and urgent: ${open.map((finding) => describe(finding.id)).join(', ')}${status.urgent.more > 0 ? `, and ${status.urgent.more} more` : ''}.`,
        );
      }
    }
    print(args, { results }, lines);
    if (failed > 0) {
      throw new Error(`project: ${failed} of ${args.ids.length} findings were not resolved.`);
    }
    return;
  }

  if (args.action === 'scans') {
    const page = await client.listProjectSecurityScans(projectId, args.limit);
    const lines = page.scans.length === 0 ? ['No scans yet.'] : formatScans(page.scans);
    if (page.nextCursor) {
      lines.push('Older scans exist. Raise --limit (up to 100) to see more.');
    }
    print(args, page, lines);
    return;
  }

  if (args.action === 'scan') {
    const scanOptions = { clientAssets: args.clientAssets };
    const preview = await client.previewProjectSecurityScan(projectId, scanOptions);
    if (args.clientAssets && preview.clientAssets !== true) {
      throw new Error(
        'project: This platform cannot read client bundle sources yet. Run the scan without --client-assets, or ask your platform admin to upgrade.',
      );
    }
    if (!args.yes) {
      if (args.json || !isInteractive(deps)) {
        throw new Error('project: Add --yes to start the scan without a prompt.');
      }
      const [question, ...rest] = rescanConfirmLines(preview);
      console.log(['', ...rest].join('\n'));
      if (!(await askYesNo(deps, question))) {
        console.log('Nothing was queued.');
        return;
      }
    }
    const queued = await client.startProjectSecurityScan(projectId, scanOptions);
    print(args, queued, [
      `✓ Full scan ${cleanLine(queued.scanId)} of ${cleanLine(queued.deploymentId)} queued${queued.clientAssets ? ', with client bundle sources' : ''}.`,
      '  It waits its turn like any scan. See the result: void project security status',
    ]);
    return;
  }

  if (args.action === 'check') {
    await runSecurityCheck(root, client, projectId, slug, args, deps);
    return;
  }

  if (args.action === 'model') {
    if (args.change === 'show') {
      const { model } = await client.getProjectSecurity(projectId);
      const lines = [
        `${slug} · security model`,
        row('Model', `${cleanLine(model.id ?? 'none')} (${modelSource(model)})`),
        row('Asked for', cleanLine(model.requested)),
        // The provider notice is only about third-party models.
        model.thirdParty || model.pendingDefault || model.pickProblem === 'notice'
          ? row(
              'Notice',
              model.noticeAccepted ? 'provider notice accepted' : 'provider notice not accepted',
            )
          : null,
        'Change: void project security model <id>   or   void project security model --default',
      ].filter((line) => line !== null);
      print(args, { model }, lines);
      return;
    }
    const target = args.change === 'default' ? null : args.model;
    const lines: Array<string> = [];
    // A version the platform does not know (0) is refused with the current version and notice.
    const set = (version?: number) =>
      client.setProjectSecurityModel(projectId, {
        model: target,
        ...(version === undefined ? {} : { acceptProviderNoticeVersion: version }),
      });
    let result;
    try {
      result = await set(args.acceptNotice ? 0 : undefined);
    } catch (error) {
      const notice = noticeOf(error);
      if (!notice) {
        throw error;
      }
      const text = notice.notice.map(cleanLine);
      if (!args.acceptNotice) {
        if (!args.json) {
          console.log(['', ...text, ''].join('\n'));
        }
        throw error;
      }
      lines.push(...text, '');
      result = await set(notice.version);
    }
    const used = result.model?.id;
    lines.push(
      args.change === 'default'
        ? `✓ ${slug} uses the platform default model${used ? ` (${cleanLine(used)})` : ''}.`
        : `✓ ${slug} scans now use ${cleanLine(args.model)}.`,
    );
    if (result.model?.source === 'fallback') {
      lines.push(
        result.model.pickProblem
          ? `  The next scan runs on ${cleanLine(result.model.id ?? 'no model')}: ${cleanLine(securityPickProblemNote(result.model.requested, result.model.pickProblem))}.`
          : '  The next scan still falls back to a Cloudflare model until the provider notice is accepted on the platform.',
      );
    }
    print(args, result, lines);
    return;
  }

  if (args.action === 'budget') {
    if (args.change === 'show') {
      const { budget } = await client.getProjectSecurity(projectId);
      if (!budget) {
        print(args, { budget: null }, [
          'Only project members who can deploy can see the scan budget.',
        ]);
        return;
      }
      const month = new Date(`${budget.month.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(
        'en-US',
        {
          month: 'long',
          timeZone: 'UTC',
        },
      );
      const cap =
        budget.capUsd === null
          ? 'no cap'
          : `${usd(budget.capUsd)} / month (${budget.capSource === 'own' ? 'set for this project' : `platform limit for ${budget.ceilingSource === 'project' ? 'this project' : budget.ceilingSource === 'plan' ? 'this plan' : 'every project'}`})`;
      print(args, { budget }, [
        `${slug} · scan budget (${month}, UTC; resets ${day(budget.resetsAt)})`,
        row('Cap', cap),
        row('Spent', `${usd(budget.spentUsd)} metered this month`),
        `  Change:    void project security budget --usd N   (project admin; ${budget.ceilingUsd === null ? 'any amount' : `$0–${usd(budget.ceilingUsd)}`})`,
      ]);
      return;
    }
    const result = await client.setProjectSecurityBudget(
      projectId,
      args.change === 'off' ? null : args.usd,
    );
    const budget = result.budget;
    if (args.change === 'set') {
      print(args, result, [
        `✓ ${slug} scan budget set to ${usd(args.usd)} / month. Spent so far: ${usd(budget.spentUsd)}.`,
      ]);
    } else {
      print(args, result, [
        budget.capUsd === null
          ? `✓ ${slug}'s own cap cleared. No cap applies.`
          : `✓ ${slug}'s own cap cleared. The platform cap for each project still applies: ${usd(budget.capUsd)} / month.`,
      ]);
    }
    return;
  }

  if (args.action === 'open') {
    const link = await client.createProjectSecurityPageLink(projectId);
    let safe: boolean;
    try {
      const url = new URL(link.url);
      safe =
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !url.username &&
        !url.password &&
        url.pathname.startsWith('/security/projects/');
    } catch {
      safe = false;
    }
    if (!safe) {
      throw new Error('project: The platform returned an unexpected security page link.');
    }
    print(args, link, [
      link.url,
      `The link works for 15 minutes (until ${stamp(link.expiresAt)}).`,
    ]);
    if (isInteractive(deps) && !args.json) {
      (deps.openUrl ?? openBrowser)(link.url);
    }
    return;
  }
}

export function isInteractive(deps: Pick<ProjectSecurityDeps, 'interactive'>): boolean {
  return deps.interactive ?? (Boolean(process.stdout.isTTY) && !isCI);
}

export async function askYesNo(
  deps: Pick<ProjectSecurityDeps, 'confirm'>,
  message: string,
): Promise<boolean> {
  if (deps.confirm) {
    return deps.confirm(message);
  }
  const answer = await confirm({ message, initialValue: false });
  return !isCancel(answer) && answer;
}

/** The status for lines added after a change; the change already happened, so errors are dropped. */
async function statusAfterChange(
  client: PlatformClient,
  projectId: string,
): Promise<ProjectSecurityStatus | null> {
  try {
    return await client.getProjectSecurity(projectId);
  } catch {
    return null;
  }
}

/**
 * `void project security check [<check-id>]` (M32). Without an id: pack this folder's
 * git-tracked files, say what is sent and to which model, confirm, upload, wait.
 * With an id: show (and wait for) that check.
 */
async function runSecurityCheck(
  root: string,
  client: PlatformClient,
  projectId: string,
  slug: string,
  args: Extract<Args, { action: 'check' }>,
  deps: ProjectSecurityDeps,
): Promise<void> {
  const log = (lines: Array<string>) => {
    if (!args.json) {
      console.log(lines.join('\n'));
    }
  };
  let checkId = args.checkId;
  const fresh = checkId === '';
  if (fresh) {
    if (!args.yes && (args.json || !isInteractive(deps))) {
      throw new Error('project: Add --yes to send the code without a prompt.');
    }
    const tree = collectSecurityLocalTree(root, deps.check?.listFiles);
    if (tree.files.length === 0) {
      throw new Error(
        'project: No git-tracked code to check in this folder. Add your code with git add first.',
      );
    }
    const packed = packSecurityLocalTree(tree);
    const preview = await client.previewProjectSecurityCheck(projectId, packed.request);
    const model = cleanLine(preview.model);
    const lines = ['', ...checkSummaryLines(slug, tree)];
    if (preview.notice) {
      lines.push('', ...preview.notice.map((line) => `  ${cleanLine(line)}`));
    }
    lines.push(
      '',
      `  The code goes to the platform and is reviewed by ${model}.${typeof preview.worstCaseUsd === 'number' ? ` It can cost up to ${usd(preview.worstCaseUsd)}; monthly caps apply.` : ' Monthly caps apply.'}`,
      '  The result is not saved as project findings. The platform keeps it for 30 days.',
    );
    log(lines);
    if (
      !args.yes &&
      !(await askYesNo(deps, `Send these files for a security check with ${model}?`))
    ) {
      console.log('Nothing was sent.');
      return;
    }
    checkId = await sendSecurityLocalCheck(client, projectId, packed, deps.check);
    log([`✓ Check ${cleanLine(checkId)} queued. It waits its turn like any scan.`]);
  } else {
    // An earlier check whose start never came (Ctrl-C, a lost reply): start it now.
    // The platform checks the upload is there, and a second start only reads the state.
    const earlier = await client.getProjectSecurityCheck(projectId, checkId);
    if (earlier.check.status === 'pending_input') {
      await client.startProjectSecurityCheck(projectId, checkId);
    }
  }
  if (!args.wait) {
    const view = await client.getProjectSecurityCheck(projectId, checkId);
    print(args, view, [
      `  Check ${cleanLine(checkId)}: ${cleanLine(view.check.status)}.`,
      `  See the result: void project security check ${cleanLine(checkId)}`,
    ]);
    return;
  }
  let view: Awaited<ReturnType<typeof waitForSecurityLocalCheck>>;
  try {
    view = await waitForSecurityLocalCheck(
      client,
      projectId,
      checkId,
      (status) => log([status === 'running' ? '  Running…' : '  Waiting in the scan queue…']),
      deps.check,
    );
  } catch (error) {
    // A lost session, a disabled platform or the network stops the wait, not the check.
    if (!(error instanceof PlatformApiError && error.status === 404)) {
      const hint = `  The check keeps running. See it later: void project security check ${cleanLine(checkId)}`;
      if (args.json) {
        console.error(hint.trim());
      } else {
        log([hint]);
      }
    }
    throw error;
  }
  if (view === null) {
    print(args, { checkId, ended: false }, [
      `  Still not done. See it later: void project security check ${cleanLine(checkId)}`,
    ]);
    return;
  }
  print(args, view, checkResultLines(slug, view, { fresh }));
  if (!checkEndedWithResult(view)) {
    throw new Error(checkFailureMessage(view, { fresh }));
  }
}
