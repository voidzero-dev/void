import { stripVTControlCharacters } from 'node:util';
import { confirm, isCancel } from '@voidzero-dev/vite-plus-prompts';
import { isCI } from 'ci-info';
import { getToken, openBrowser } from './auth.ts';
import { PlatformApiError, PlatformClient } from './client.ts';
import type { ProjectSecurityArgs } from './project-security-args.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, requireProjectBySlug } from './resolve-project.ts';
import type {
  ProjectSecurityStatus,
  SecurityFinding,
  SecurityFindingEvent,
  SecurityPublicRequest,
  SecurityRescanPreview,
  SecurityScanSummary,
} from './security-api-types.ts';

type Args = ProjectSecurityArgs;

function scrub(value: string, keepNewline: boolean): string {
  let out = '';
  for (const char of stripVTControlCharacters(value)) {
    const code = char.codePointAt(0)!;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += control && !(keepNewline && char === '\n') ? ' ' : char;
  }
  return out;
}

/** Text from a model or a user: no escape sequences, one line. */
export function cleanLine(value: unknown): string {
  return scrub(String(value ?? ''), false);
}

/** Text from a model that may span lines: keeps line breaks, drops every other control. */
export function cleanBlock(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return scrub(text ?? '', true);
}

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

/** Where a platform limit comes from (`ceilingSource`); older platforms send none. */
function platformLimitLabel(source: 'project' | 'plan' | 'default' | null | undefined): string {
  if (source === 'project') {
    return 'platform limit for this project';
  }
  if (source === 'plan') {
    return 'platform limit for this plan';
  }
  return 'platform limit for every project';
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

const row = (label: string, text: string) => `  ${label.padEnd(10)} ${text}`;
const cont = (text: string) => `  ${' '.repeat(10)} ${text}`;

/** Spec §11.4 status copy for the last scan; `null` when the scan needs no explanation. */
export function scanStatusCopy(status: ProjectSecurityStatus): string | null {
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
        if (budget && budget.capSource === 'own' && budget.capUsd !== null) {
          return `Not scanned: this project's monthly scan budget is used up (${usd(budget.spentUsd)} of ${usd(budget.capUsd)}). Resets ${day(budget.resetsAt)}.`;
        }
        return "Not scanned: the platform's monthly scan budget is used up. Your platform admin can raise it.";
      }
      if (reason === 'backlog') {
        return `Not scanned: the scan queue was full for 24 h. ${next}`;
      }
      if (reason === 'protected') {
        return 'Not scanned: this project is protected by Zero Trust and the platform scans public projects only.';
      }
      return `Not scanned (${reason}).`;
    default:
      return null;
  }
}

/** Spec §11.4 public request copy, with the command that moves it on. */
export function publicRequestLines(
  slug: string,
  request: SecurityPublicRequest,
  status: Pick<ProjectSecurityStatus, 'backlogFiles' | 'budget'>,
): Array<string> {
  const ids = request.blockers.ids.map(cleanLine).join(', ');
  const target = cleanLine(request.targetDeploymentId);
  const bypass = 'void project zero-trust bypass --reason "…"';
  const reason = request.heldReason;
  const lines: Array<string> = [];
  switch (request.state) {
    case 'waiting_scan':
      lines.push(
        status.backlogFiles > 0
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
      if (reason === 'failed_installation') {
        lines.push(
          `Stays protected: the security scan could not run (a platform problem; your platform admin can see it). A project admin or owner can bypass the scan: ${bypass}`,
        );
      } else if (reason === 'skipped_budget') {
        const resets = status.budget ? ` Resets ${day(status.budget.resetsAt)}.` : '';
        lines.push(
          `Stays protected: the monthly scan budget is used up, so the scan could not run.${resets} Ask your platform admin, or bypass the scan: ${bypass}`,
        );
      } else {
        const cause =
          reason === 'refused'
            ? 'refused'
            : reason === 'timed_out'
              ? 'timed out'
              : reason === 'findings_capped'
                ? 'it hit the findings limit, so more findings may be hidden'
                : reason === 'failed_project'
                  ? 'the scan of this project failed'
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

export function formatStatus(slug: string, status: ProjectSecurityStatus): Array<string> {
  const lines = [`${slug} · security`];
  const { urgent, policy, model, budget, lastScan, lastSuccessfulScan, counts } = status;
  if (urgent.count === 0) {
    lines.push(row('Urgent', 'none open'));
  } else {
    const parts = [
      urgent.counts.critical ? `${urgent.counts.critical} critical` : '',
      urgent.counts.high ? `${urgent.counts.high} high` : '',
    ].filter(Boolean);
    lines.push(
      row(
        'Urgent',
        `${urgent.count} open (${parts.join(', ')}) · oldest ${day(urgent.oldestFirstSeenAt)}  → void project security list --urgent`,
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
  const source =
    model.source === 'project'
      ? "your project's pick"
      : model.source === 'default'
        ? 'platform default'
        : model.source === 'fallback'
          ? 'fallback: the model you asked for cannot run now'
          : 'no model can run now';
  lines.push(row('Model', `${cleanLine(model.id ?? 'none')} (${source})`));
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
    lines.push(
      row(
        'Last scan',
        'none yet. The first scan runs after your next deploy and reviews the whole app.',
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
  const copy = scanStatusCopy(status);
  if (copy) {
    lines.push(row('Note', copy));
  }
  const other =
    (counts.open.medium ?? 0) + (counts.open.low ?? 0) + (counts.open.informational ?? 0);
  lines.push(row('Open', `${counts.urgent} urgent · ${other} other · ${counts.leads} leads`));
  if (status.publicRequest) {
    const [first = '', ...rest] = publicRequestLines(slug, status.publicRequest, status);
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
    finding.confidence !== undefined && finding.confidence !== null
      ? `confidence ${cleanLine(finding.confidence)}`
      : null,
    finding.deploymentId ? `first seen in ${cleanLine(finding.deploymentId)}` : null,
    finding.firstSeenAt ? day(finding.firstSeenAt) : null,
  ].filter(Boolean);
  if (meta.length > 0) {
    lines.push(`  ${meta.join(' · ')}`);
  }
  if (finding.notSeenInLatest) {
    lines.push('  Not seen in the latest scan.');
  }
  if (finding.possibleDuplicateOf) {
    lines.push(`  Possible duplicate of ${cleanLine(finding.possibleDuplicateOf.id)}.`);
  }
  for (const [label, value] of [
    ['Trace', finding.trace],
    ['Evidence', finding.evidence],
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
      lines.push(
        `    ${stamp(event.createdAt)} · ${cleanLine(event.action)}${event.resolution ? ` (${cleanLine(event.resolution).split('_').join('-')})` : ''} · ${cleanLine(who)}${event.actorRole ? ` (${cleanLine(event.actorRole)})` : ''}`,
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

async function resolveTarget(root: string, args: Args) {
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

export type ProjectSecurityDeps = {
  openUrl?: (url: string) => void;
  interactive?: boolean;
  confirm?: (message: string) => Promise<boolean>;
};

/** The rescan cost confirm (spec §13.4 rescan rule): what it runs and what it can cost. */
export function rescanConfirmLines(preview: SecurityRescanPreview): Array<string> {
  const id = cleanLine(preview.deploymentId);
  const model = cleanLine(preview.model ?? 'the scan model');
  const cost =
    typeof preview.worstCaseUsd === 'number'
      ? ` It can cost up to ${usd(preview.worstCaseUsd)}.`
      : '';
  const lines = [
    preview.alreadyScanned
      ? `Live deployment ${id} was already scanned. Run a full scan with ${model}? This reviews the whole app.${cost}`
      : `Run a full scan of live deployment ${id} with ${model}? This reviews the whole app.${cost}`,
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
    print(args, status, formatStatus(slug, status));
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

  if (args.action === 'reopen') {
    const current = await client.getProjectSecurityFinding(projectId, args.id);
    const result = await client.reopenProjectSecurityFinding(projectId, args.id, {
      comment: args.comment,
      expectedRevision: current.finding.revision,
    });
    print(args, result, [`✓ ${cleanLine(result.id)} reopened.`]);
    return;
  }

  if (args.action === 'resolve') {
    const results: Array<Record<string, unknown>> = [];
    const lines: Array<string> = [];
    let lastRequest: SecurityPublicRequest | undefined;
    let failed = 0;
    for (const id of args.ids) {
      try {
        const current = await client.getProjectSecurityFinding(projectId, id);
        const result = await client.resolveProjectSecurityFinding(projectId, id, {
          reason: args.reason,
          comment: args.comment,
          expectedRevision: current.finding.revision,
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
      let status: ProjectSecurityStatus | null = null;
      try {
        status = await client.getProjectSecurity(projectId);
      } catch {
        // The lines below are extra; the resolves already happened.
      }
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
    const preview = await client.previewProjectSecurityScan(projectId);
    if (!args.yes) {
      const interactive = deps.interactive ?? (Boolean(process.stdout.isTTY) && !isCI);
      if (args.json || !interactive) {
        throw new Error('project: Add --yes to start the scan without a prompt.');
      }
      const [question, ...rest] = rescanConfirmLines(preview);
      console.log(['', ...rest].join('\n'));
      const ask =
        deps.confirm ??
        (async (message: string) => {
          const answer = await confirm({ message, initialValue: false });
          return !isCancel(answer) && answer;
        });
      if (!(await ask(question!))) {
        console.log('Nothing was queued.');
        return;
      }
    }
    const queued = await client.startProjectSecurityScan(projectId);
    print(args, queued, [
      `✓ Full scan ${cleanLine(queued.scanId)} of ${cleanLine(queued.deploymentId)} queued.`,
      '  It waits its turn like any scan. See the result: void project security status',
    ]);
    return;
  }

  if (args.action === 'model') {
    if (args.change === 'show') {
      const { model } = await client.getProjectSecurity(projectId);
      const lines = [
        `${slug} · security model`,
        row('Model', `${cleanLine(model.id ?? 'none')}${model.source ? ` (${model.source})` : ''}`),
        row('Asked for', cleanLine(model.requested)),
        row(
          'Notice',
          model.noticeAccepted ? 'provider notice accepted' : 'provider notice not accepted',
        ),
        'Change: void project security model <id>   or   void project security model --default',
      ];
      print(args, { model }, lines);
      return;
    }
    const target = args.change === 'default' ? null : args.model;
    const lines: Array<string> = [];
    let result;
    if (args.acceptNotice) {
      try {
        // A version the platform does not know is refused with the current version and notice.
        result = await client.setProjectSecurityModel(projectId, {
          model: target,
          acceptProviderNoticeVersion: 0,
        });
      } catch (error) {
        const notice = noticeOf(error);
        if (!notice) {
          throw error;
        }
        lines.push(...notice.notice.map((line) => cleanLine(line)), '');
        result = await client.setProjectSecurityModel(projectId, {
          model: target,
          acceptProviderNoticeVersion: notice.version,
        });
      }
    } else {
      try {
        result = await client.setProjectSecurityModel(projectId, { model: target });
      } catch (error) {
        const notice = noticeOf(error);
        if (notice && !args.json) {
          console.log(['', ...notice.notice.map((line) => cleanLine(line)), ''].join('\n'));
        }
        throw error;
      }
    }
    const used = result.model?.id;
    lines.push(
      args.change === 'default'
        ? `✓ ${slug} uses the platform default model${used ? ` (${cleanLine(used)})` : ''}.`
        : `✓ ${slug} scans now use ${cleanLine(args.model)}.`,
    );
    if (result.model?.source === 'fallback') {
      lines.push(
        '  The next scan still falls back to a Cloudflare model until the provider notice is accepted on the platform.',
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
      const month = new Date(`${budget.month}-01T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'long',
        timeZone: 'UTC',
      });
      const cap =
        budget.capUsd === null
          ? 'no cap'
          : `${usd(budget.capUsd)} / month (${budget.capSource === 'own' ? 'set for this project' : platformLimitLabel(budget.ceilingSource)})`;
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
    let safe = false;
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
    const interactive = deps.interactive ?? (Boolean(process.stdout.isTTY) && !isCI);
    if (interactive && !args.json) {
      (deps.openUrl ?? openBrowser)(link.url);
    }
    return;
  }

  if (args.action === '') {
    return;
  }
}
