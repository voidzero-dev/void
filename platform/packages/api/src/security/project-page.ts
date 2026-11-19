/**
 * The project security page (spec §13.2): what a signed-in project member sees at
 * `/security/projects/:slug`, and the landing page everyone else gets. Read-only; the
 * commands are shown as text to copy. Role decides the detail:
 *
 *   settings (owner, admin)  everything, the resolve / budget / bypass commands
 *   deploy (collaborator)    everything except the resolve command
 *   read (reader)            counts, F-ids, titles of resolved findings, no budget or scans
 *
 * Every dynamic value goes through `esc`. Model text is plain text: no Markdown, links
 * or images. Only `loadSecurityPage` touches the database, and only to read.
 */
import { escapeBrowserHtml } from '@void/platform/browser-page';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { hasProjectCapability } from '../project-access.ts';
import type { ProjectRole } from '../types.ts';
import { formatSecurityDay, formatSecurityStamp } from './notification-copy.ts';
import { listSecurityFindings, type SecurityFindingView } from './project-findings.ts';
import {
  listSecurityScans,
  projectSecurityStatus,
  securityDetailLevel,
  type SecurityScanView,
} from './project-view.ts';
import { publicRequestCopy } from './public-gate-copy.ts';
import { openPublicRequestView, type PublicRequestView } from './public-gate.ts';
import { securityScanBypasses } from './schema.ts';

/** The most findings one block lists; the CLI has the rest. */
export const SECURITY_PAGE_FINDINGS_SHOWN = 100;
const SCANS_SHOWN = 10;

const esc = escapeBrowserHtml;

export type SecurityPageBypass = Readonly<{
  total: number;
  /** The reason stays `null` for readers. */
  latest: Readonly<{ at: string; actorRole: string | null; reason: string | null }> | null;
}>;

type Status = Awaited<ReturnType<typeof projectSecurityStatus>>;

export type SecurityPageData = Readonly<{
  slug: string;
  role: ProjectRole;
  status: Status;
  open: ReadonlyArray<SecurityFindingView>;
  resolved: ReadonlyArray<SecurityFindingView>;
  scans: ReadonlyArray<SecurityScanView> | null;
  request: PublicRequestView | null;
  bypass: SecurityPageBypass;
}>;

export async function loadSecurityPage(
  db: Db,
  input: Readonly<{
    project: Readonly<{ id: string; slug: string }>;
    role: ProjectRole;
    capability: boolean;
    now?: number;
  }>,
): Promise<SecurityPageData> {
  const { project, role } = input;
  const viewer = { role, credential: false };
  const level = securityDetailLevel(viewer);
  const page = { limit: SECURITY_PAGE_FINDINGS_SHOWN, afterNumber: null };
  const [status, urgentOpen, open, resolved, request, bypasses] = await Promise.all([
    projectSecurityStatus({
      db,
      project,
      viewer,
      capability: input.capability,
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
    // Urgent findings load on their own so none falls past the cap on the other open ones.
    listSecurityFindings(
      db,
      project.id,
      level,
      { state: 'open', urgent: true, severity: null },
      page,
    ),
    listSecurityFindings(
      db,
      project.id,
      level,
      { state: 'open', urgent: false, severity: null },
      page,
    ),
    listSecurityFindings(
      db,
      project.id,
      level,
      { state: 'resolved', urgent: false, severity: null },
      page,
    ),
    openPublicRequestView(db, project.id),
    db
      .select({
        at: securityScanBypasses.created_at,
        role: securityScanBypasses.actor_role,
        reason: securityScanBypasses.reason,
      })
      .from(securityScanBypasses)
      .where(eq(securityScanBypasses.project_id, project.id))
      .orderBy(desc(securityScanBypasses.created_at)),
  ]);
  const newest = bypasses[0];
  const scans =
    level === 'full'
      ? (await listSecurityScans(db, project.id, level, { limit: SCANS_SHOWN, cursor: null })).scans
      : null;
  return {
    slug: project.slug,
    role,
    status,
    open: [
      ...urgentOpen.findings,
      ...open.findings.filter(
        (finding) => !urgentOpen.findings.some((urgent) => urgent.id === finding.id),
      ),
    ],
    resolved: resolved.findings,
    scans,
    request,
    bypass: {
      total: bypasses.length,
      latest: newest
        ? {
            at: newest.at,
            actorRole: newest.role,
            reason: level === 'full' ? newest.reason : null,
          }
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function usd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function stamp(iso: string | null): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? 'unknown time' : formatSecurityStamp(ms);
}

function day(iso: string | null): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? 'unknown date' : formatSecurityDay(ms);
}

function plainText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(plainText).join('\n');
  }
  return JSON.stringify(value);
}

function roleLabel(role: string | null): string {
  switch (role) {
    case 'owner':
      return 'the project owner';
    case 'admin':
      return 'a project admin';
    case 'collaborator':
      return 'a collaborator';
    case 'installation_admin':
      return 'a platform admin';
    default:
      return 'a project member';
  }
}

function code(text: string): string {
  return `<pre><code>${esc(text)}</code></pre>`;
}

function row(label: string, html: string): string {
  return `<div><dt>${esc(label)}</dt><dd>${html}</dd></div>`;
}

function detailField(label: string, value: unknown): string {
  const text = plainText(value);
  return text ? `<p><strong>${esc(label)}</strong></p>${code(text)}` : '';
}

const PAGE_STYLE = `<style>
.void-auth-page .void-auth-container{max-width:860px}
.void-auth-page .sec-banner{padding:12px 14px;border-radius:var(--auth-radius-inner);background:var(--auth-error-bg);color:var(--auth-error)}
.void-auth-page .sec-banner p{color:inherit}
.void-auth-page .sec-ok{padding:12px 14px;border-radius:var(--auth-radius-inner);background:var(--auth-success-bg);color:var(--auth-success)}
.void-auth-page .sec-ok p{color:inherit}
.void-auth-page details{border:1px solid var(--auth-border);border-radius:var(--auth-radius-inner);padding:8px 12px}
.void-auth-page summary{cursor:pointer;overflow-wrap:anywhere}
.void-auth-page details>*+*{margin-top:10px}
.void-auth-page .sec-list{display:grid;gap:8px}
.void-auth-page .sec-sev{font-weight:600;text-transform:uppercase;font-size:12px}
.void-auth-page .sec-file{font:12px ui-monospace,Menlo,monospace;color:var(--auth-secondary)}
.void-auth-page .void-auth-identity>div{grid-template-columns:96px minmax(0,1fr)}
</style>`;

function findingBlock(finding: SecurityFindingView, full: boolean): string {
  const id = plainText(finding.id);
  const severity = typeof finding.severity === 'string' ? finding.severity : 'lead';
  if (!full) {
    const title = typeof finding.title === 'string' ? ` ${esc(finding.title)}` : '';
    return `<p><span class="sec-sev">${esc(severity)}</span> ${esc(id)}${title}</p>`;
  }
  const where = finding.file
    ? `${plainText(finding.file)}${finding.line ? `:${plainText(finding.line)}` : ''}`
    : '';
  const summary = `<summary><span class="sec-sev">${esc(severity)}</span> ${esc(id)} ${esc(
    plainText(finding.title),
  )}${where ? ` <span class="sec-file">${esc(where)}</span>` : ''}</summary>`;
  const meta = [finding.category, finding.cwe, finding.confidence]
    .map(plainText)
    .filter(Boolean)
    .join(' · ');
  const resolution =
    finding.state === 'resolved'
      ? `<p>Resolved as ${esc(plainText(finding.resolution))}${
          finding.resolvedBy ? ` by ${esc(plainText(finding.resolvedBy))}` : ''
        }.</p>`
      : '';
  return `<details>${summary}${meta ? `<p>${esc(meta)}</p>` : ''}${detailField(
    'Trace',
    finding.trace,
  )}${detailField('Evidence', finding.evidence)}${detailField(
    'Conditions',
    finding.conditions,
  )}${detailField('Suggested fix', finding.fix)}${resolution}</details>`;
}

/** Says so when a list is cut, and where the rest is. */
function cutNote(shown: number, total: number): string {
  return shown < total
    ? `<p class="void-auth-note">${esc(
        `Showing ${shown} of ${total}. See the rest with: void project security findings`,
      )}</p>`
    : '';
}

function findingList(
  heading: string,
  findings: ReadonlyArray<SecurityFindingView>,
  full: boolean,
  total: number,
): string {
  if (findings.length === 0) {
    return '';
  }
  return `<div class="void-auth-section"><h2>${esc(heading)}</h2><div class="sec-list">${findings
    .map((finding) => findingBlock(finding, full))
    .join('')}</div>${cutNote(findings.length, total)}</div>`;
}

/** Spec §11.4 status copy for the last scan; `null` when no copy applies. */
export function scanStatusCopy(data: SecurityPageData): string | null {
  const { lastScan, lastSuccessfulScan, budget } = data.status;
  if (!lastScan) {
    return null;
  }
  const since = lastSuccessfulScan?.deploymentId ?? null;
  const next = since
    ? `The next scan covers changes since ${since}.`
    : 'The next scan reviews the whole app.';
  const reason = lastScan.statusReason ?? 'unknown';
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
      return `Refused by ${lastScan.model ?? 'the scan model'} (category: ${
        lastScan.refusalCategory ?? 'unknown'
      }). The next deploy is scanned again.`;
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
        if (!budget) {
          return 'Not scanned: the monthly scan budget is used up.';
        }
        return budget.capSource !== 'limit' && budget.capUsd !== null
          ? `Not scanned: this project's monthly scan budget is used up (${usd(budget.spentUsd)} of ${usd(
              budget.capUsd,
            )}). Resets ${day(budget.resetsAt)}.`
          : "Not scanned: the platform's monthly scan budget is used up. Your platform admin can raise it.";
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

function lastScanRow(data: SecurityPageData, full: boolean): string {
  const scan = data.status.lastSuccessfulScan ?? data.status.lastScan;
  if (!scan) {
    return esc(
      'No scan yet. The first scan runs after your next deploy and reviews the whole app.',
    );
  }
  const parts: Array<string> = [scan.status];
  if (scan.deploymentId) {
    parts.push(scan.deploymentId);
  }
  if (full && scan.model) {
    parts.push(scan.model);
  }
  if (scan.finishedAt) {
    parts.push(stamp(scan.finishedAt));
  }
  const lines = [esc(parts.join(' · '))];
  if (scan.coverageLabel) {
    lines.push(esc(scan.coverageLabel));
  }
  const copy = scanStatusCopy(data);
  if (copy) {
    lines.push(esc(copy));
  }
  return lines.join('<br>');
}

function requestBlock(data: SecurityPageData, settings: boolean): string {
  const { request, slug } = data;
  if (!request) {
    return '';
  }
  const copy = publicRequestCopy({
    slug,
    state: request.state,
    // Readers get the state and F-ids only, no reasons.
    reason: data.role === 'reader' ? null : request.heldReason,
    blockerIds: request.blockers.ids,
    deploymentId: request.targetDeploymentId,
    backlogFiles: data.status.backlogFiles,
  });
  const lines = [
    esc(copy),
    esc(`Asked by ${roleLabel(request.requestedByRole)} on ${day(request.requestedAt)}.`),
  ];
  if (!settings) {
    // A collaborator gets this line once, from the page help.
    if (request.state === 'held_findings' && data.role === 'reader') {
      lines.push('A project admin or owner can resolve these.');
    } else if (request.state === 'held_no_result' || request.state === 'needs_deploy') {
      lines.push('A project admin or owner can bypass the scan.');
    }
  }
  return lines.join('<br>');
}

function bypassLine(data: SecurityPageData): string | null {
  const { total, latest } = data.bypass;
  if (total === 0 || !latest) {
    return null;
  }
  const times = `Bypassed ${total} ${total === 1 ? 'time' : 'times'}`;
  if (latest.reason === null) {
    return times;
  }
  return `${times}: ${day(latest.at)}, by ${roleLabel(latest.actorRole)} ("${latest.reason}")`;
}

function modelLine(data: SecurityPageData): string | null {
  const { model } = data.status;
  if (model.thirdParty && model.id) {
    return `Scans run on ${model.id}, a third-party model: its provider's usage policy applies and it may refuse. See: void project security model`;
  }
  if (model.pendingDefault) {
    return `The platform default is ${model.pendingDefault}. Accept to use it: void project security model --default --accept-provider-notice`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** Plain links (email, GitHub) land here: no project data, only how to open the page. */
export function renderSecurityLanding(slug: string): string {
  return (
    '<div class="void-auth-lead"><h1 id="void-auth-title">Project security</h1>' +
    '<p>This page shows no findings until you open it from the Void CLI.</p></div>' +
    '<p>Open this page from the CLI:</p>' +
    code(`void project security open --project ${slug}`) +
    '<p class="void-auth-note">The link it opens works for 15 minutes.</p>'
  );
}

export function renderSecurityInvalidLink(slug: string): string {
  return (
    '<div class="void-auth-lead"><h1 id="void-auth-title">This link no longer works</h1>' +
    '<p>It is invalid, expired, or for another project. Open a new one from the Void CLI.</p></div>' +
    code(`void project security open --project ${slug}`)
  );
}

export function renderSecurityPage(data: SecurityPageData): string {
  const { status, slug, role } = data;
  const settings = hasProjectCapability(role, 'settings');
  const full = hasProjectCapability(role, 'deploy');
  const head = `<div class="void-auth-lead"><h1 id="void-auth-title">${esc(slug)} · Security</h1></div>`;
  if (status.policy.mode === 'disabled') {
    return PAGE_STYLE + head + `<p>${esc(status.policy.reason)}</p>`;
  }

  const urgent = status.urgent;
  const openTotal = Object.values(status.counts.open).reduce((sum, value) => sum + value, 0);
  let banner = '';
  if (urgent.count > 0) {
    banner = `<div class="sec-banner"><p><strong>${urgent.count} urgent ${
      urgent.count === 1 ? 'finding is' : 'findings are'
    } open</strong> (${urgent.counts.critical} critical, ${urgent.counts.high} high)${
      urgent.oldestFirstSeenAt ? ` · oldest ${esc(stamp(urgent.oldestFirstSeenAt))}` : ''
    }</p><p>Fix the code, then a project admin or owner resolves them.</p></div>`;
  } else if (openTotal === 0 && status.lastSuccessfulScan) {
    banner = `<div class="sec-ok"><p>✓ No open findings. Last scan: ${esc(
      stamp(status.lastSuccessfulScan.finishedAt),
    )}</p></div>`;
  }

  const rows: Array<string> = [row('Last scan', lastScanRow(data, full))];
  rows.push(
    row(
      'Policy',
      esc(
        status.policy.applies
          ? `applies: ${status.policy.reason}`
          : `does not apply: ${status.policy.reason}`,
      ),
    ),
  );
  if (full && status.budget) {
    const { budget } = status;
    rows.push(
      row(
        'Budget',
        esc(
          `${usd(budget.spentUsd)}${budget.capUsd === null ? '' : ` of ${usd(budget.capUsd)}`} this month${
            budget.capSource === 'own' ? ' (project cap)' : ''
          } · resets ${day(budget.resetsAt)}`,
        ),
      ),
    );
  }
  const request = requestBlock(data, settings);
  if (request) {
    rows.push(row('Public', request));
  }
  const bypass = bypassLine(data);
  if (bypass) {
    rows.push(row('Bypass', esc(bypass)));
  }
  const model = modelLine(data);
  if (model) {
    rows.push(row('Model', esc(model)));
  }
  if (status.backlogFiles > 0) {
    rows.push(
      row(
        'Backlog',
        esc(`Unscanned backlog: ${status.backlogFiles} files (next scans cover more)`),
      ),
    );
  }

  const urgentRows = data.open.filter((finding) => finding.urgent === true);
  const otherRows = data.open.filter(
    (finding) => finding.urgent !== true && finding.verdict !== 'needs_validation',
  );
  const leads = data.open.filter((finding) => finding.verdict === 'needs_validation');

  const otherTotal = Math.max(0, openTotal - urgent.count);
  const leadsTotal = status.counts.leads;
  const resolvedTotal = status.counts.resolved;
  let lists: string;
  if (full) {
    lists =
      findingList('Urgent (confirmed critical or high)', urgentRows, true, urgent.count) +
      findingList(`Other open: ${otherTotal}`, otherRows, true, otherTotal) +
      findingList(`Leads (need a human look): ${leadsTotal}`, leads, true, leadsTotal) +
      findingList(`Resolved: ${resolvedTotal}`, data.resolved, true, resolvedTotal);
  } else {
    const counts = status.counts.open;
    lists =
      `<div class="void-auth-section"><h2>Open findings</h2><p>${esc(
        `Urgent ${urgent.count} · critical ${counts.critical} · high ${counts.high} · medium ${counts.medium} · low ${counts.low} · informational ${counts.informational} · leads ${status.counts.leads}`,
      )}</p>` +
      (data.open.length > 0
        ? `<p>${esc(data.open.map((finding) => plainText(finding.id)).join(', '))}</p>`
        : '') +
      cutNote(data.open.length, openTotal + leadsTotal) +
      '</div>' +
      findingList(`Resolved: ${resolvedTotal}`, data.resolved, false, resolvedTotal);
  }

  let scans = '';
  if (data.scans && data.scans.length > 0) {
    scans = `<div class="void-auth-section"><h2>Scans</h2><div class="sec-list">${data.scans
      .map(
        (scan) =>
          `<p>${esc(
            [
              stamp(scan.createdAt),
              scan.status,
              scan.trigger,
              scan.deploymentId ?? '',
              scan.model ?? '',
              scan.meteredUsd === null ? '' : usd(scan.meteredUsd),
            ]
              .filter(Boolean)
              .join(' · '),
          )}</p>`,
      )
      .join('')}</div></div>`;
  }

  const commands: Array<string> = [];
  const firstUrgent = urgentRows[0] ? plainText(urgentRows[0].id) : 'F-1';
  if (settings) {
    commands.push(`void project security resolve ${firstUrgent} --reason fixed --comment "…"`);
    commands.push('void project security budget --usd 100');
    const state = data.request?.state;
    // A bypass skips the scan only; with urgent findings open the resolve command is the next step.
    if (
      urgent.count === 0 &&
      (state === 'waiting_scan' || state === 'held_no_result' || state === 'needs_deploy')
    ) {
      commands.push('void project zero-trust bypass --reason "…"');
    }
  } else if (full) {
    commands.push(`void project security comment ${firstUrgent} "…"`);
  }
  const help =
    (full && !settings ? '<p>A project admin or owner can resolve these.</p>' : '') +
    (commands.length > 0 ? code(commands.join('\n')) : '');

  const notes =
    '<p class="void-auth-note">AI review can be wrong. "No findings" does not mean "no bugs". ' +
    'Security findings never block deploys. With "Scan before a project goes public" on, they hold a public request.</p>';

  return (
    PAGE_STYLE +
    head +
    banner +
    `<dl class="void-auth-identity">${rows.join('')}</dl>` +
    lists +
    scans +
    help +
    notes
  );
}
