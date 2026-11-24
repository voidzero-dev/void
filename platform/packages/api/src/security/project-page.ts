/**
 * The project security page (spec §13.2): what a signed-in project member sees at
 * `/security/projects/:slug`, and the landing page everyone else gets. Role decides the
 * detail and the forms (Phase 2, M29; `routes/security-page.ts` handles the posts):
 *
 *   settings (owner, admin)  everything; resolve, comment, model, budget and bypass forms
 *   deploy (collaborator)    everything; the comment form, no resolve
 *   read (reader)            counts, F-ids, titles of resolved findings, no budget or scans
 *
 * The CLI commands stay shown as text to copy. Every dynamic value goes through `esc`.
 * Model text is plain text: no Markdown, links or images. Only `loadSecurityPage`
 * touches the database, and only to read.
 */
import { escapeBrowserHtml } from '@void/platform/browser-page';
import { securityPickProblemNote } from '@void/platform/security-models';
import { parseSecurityFindingLabel, securityTraceLines } from '@void/platform/security-policy';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { hasProjectCapability } from '../project-access.ts';
import type { ProjectRole } from '../types.ts';
import { formatSecurityDay, formatSecurityStamp } from './notification-copy.ts';
import {
  listSecurityFindings,
  SECURITY_COMMENT_MAX_CHARS,
  securityFindingTimelines,
  type SecurityFindingEventView,
  type SecurityFindingView,
} from './project-findings.ts';
import { SECURITY_PROJECT_POLICY_SKIP_REASON } from './project-policy.ts';
import { readSecurityProjectModelChoices, type SecurityModelChoices } from './project-settings.ts';
import {
  listSecurityScans,
  projectSecurityStatus,
  securityDetailLevel,
  type SecurityScanView,
} from './project-view.ts';
import { publicRequestCopy } from './public-gate-copy.ts';
import {
  openPublicRequestView,
  SECURITY_BYPASS_REASON_MAX_CHARS,
  type PublicRequestView,
} from './public-gate.ts';
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
  /** Each shown finding's history by internal finding id (deploy roles only). */
  timelines: ReadonlyMap<string, ReadonlyArray<SecurityFindingEventView>>;
  scans: ReadonlyArray<SecurityScanView> | null;
  request: PublicRequestView | null;
  bypass: SecurityPageBypass;
  /** What the model form lists (the same rules the model setter checks). */
  modelChoices: SecurityModelChoices;
}>;

/** A line at the top of the page after a form post. */
export type SecurityPageNotice = Readonly<{ kind: 'ok' | 'error'; text: string }>;

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
  const [status, urgentOpen, open, resolved, request, bypasses, modelChoices] = await Promise.all([
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
    readSecurityProjectModelChoices(db, project.id),
  ]);
  const newest = bypasses[0];
  const openShown = [
    ...urgentOpen.findings,
    ...open.findings.filter(
      (finding) => !urgentOpen.findings.some((urgent) => urgent.id === finding.id),
    ),
  ];
  const [scans, timelines] =
    level === 'full'
      ? await Promise.all([
          listSecurityScans(db, project.id, level, { limit: SCANS_SHOWN, cursor: null }).then(
            (list) => list.scans,
          ),
          securityFindingTimelines(
            db,
            project.id,
            [...openShown, ...resolved.findings].flatMap((finding) =>
              typeof finding.findingId === 'string' ? [finding.findingId] : [],
            ),
          ),
        ])
      : [null, new Map<string, ReadonlyArray<SecurityFindingEventView>>()];
  return {
    slug: project.slug,
    role,
    status,
    open: openShown,
    resolved: resolved.findings,
    timelines,
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
    modelChoices,
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

/** The finding's history, oldest first, as the CLI `show` prints it. */
function timelineField(events: ReadonlyArray<SecurityFindingEventView> | undefined): string {
  if (!events || events.length === 0) {
    return '';
  }
  const items = events.map((event) => {
    const action = plainText(event.action).split('_').join(' ');
    const resolution = event.resolution
      ? ` (${plainText(event.resolution).split('_').join(' ')})`
      : '';
    const severity =
      event.severityFrom && event.severityTo
        ? ` (${plainText(event.severityFrom)} → ${plainText(event.severityTo)})`
        : '';
    const who = plainText(event.actor) || plainText(event.actorKind);
    // Spec #24: a removed commenter keeps the comment, shown as a former member.
    const role = event.formerMember === true ? 'former member' : plainText(event.actorRole);
    const line = `${stamp(typeof event.createdAt === 'string' ? event.createdAt : null)} · ${action}${resolution}${severity} · ${who}${role ? ` (${role})` : ''}`;
    const comment = plainText(event.comment);
    return `<li>${esc(line)}${comment ? code(comment) : ''}</li>`;
  });
  return `<p><strong>History</strong></p><ul class="sec-history">${items.join('')}</ul>`;
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
.void-auth-page .sec-history{display:grid;gap:6px;margin:0;padding-left:18px}
.void-auth-page .sec-file{font:12px ui-monospace,Menlo,monospace;color:var(--auth-secondary)}
.void-auth-page .void-auth-identity>div{grid-template-columns:96px minmax(0,1fr)}
.void-auth-page .sec-form{border-top:1px solid var(--auth-border);padding-top:10px}
.void-auth-page :is(select,textarea){width:100%;min-width:0;padding:8px 12px;border:1px solid var(--auth-border);border-radius:var(--auth-radius-element);background:var(--auth-body);color:var(--auth-text);font:inherit}
.void-auth-page select{height:44px}
.void-auth-page textarea{min-height:88px;resize:vertical}
.void-auth-page .sec-check{display:flex;gap:8px;align-items:flex-start;font-weight:400}
.void-auth-page .sec-check input{width:auto;height:auto;margin-top:4px}
.void-auth-page .sec-form .void-auth-button{width:auto;justify-self:start}
</style>`;

/** Where a page form posts: below the page path, so the path-scoped cookie is sent. */
export function securityPageFormPath(slug: string, ...parts: ReadonlyArray<string>): string {
  return ['/security/projects', slug, ...parts]
    .map((part, index) => (index === 0 ? part : encodeURIComponent(part)))
    .join('/');
}

function form(action: string, body: string, button: string): string {
  return `<form class="sec-form" method="post" action="${esc(action)}">${body}<button class="void-auth-button" type="submit">${esc(
    button,
  )}</button></form>`;
}

function textArea(name: string, id: string, label: string, max: number): string {
  return `<label for="${esc(id)}">${esc(label)}</label><textarea id="${esc(id)}" name="${esc(
    name,
  )}" required maxlength="${max}"></textarea>`;
}

/** Which finding forms the viewer gets: comment needs `configure`, resolve `settings`. */
type FindingForms = Readonly<{ slug: string; comment: boolean; resolve: boolean }>;

function findingForms(finding: SecurityFindingView, forms: FindingForms | null): string {
  const id = plainText(finding.id);
  if (!forms || parseSecurityFindingLabel(id) === null) {
    return '';
  }
  const key = id.toLowerCase();
  let html = '';
  if (forms.resolve && finding.state === 'open' && typeof finding.revision === 'number') {
    html += form(
      securityPageFormPath(forms.slug, 'findings', id, 'resolve'),
      `<label for="sec-reason-${key}">Resolve as</label><select id="sec-reason-${key}" name="reason">` +
        '<option value="fixed">Fixed</option><option value="false_positive">False positive</option>' +
        '<option value="accepted_risk">Accepted risk</option></select>' +
        textArea(
          'comment',
          `sec-resolve-${key}`,
          'Why (shown in the history)',
          SECURITY_COMMENT_MAX_CHARS,
        ) +
        `<input type="hidden" name="expectedRevision" value="${finding.revision}">`,
      `Resolve ${id}`,
    );
  }
  if (forms.comment) {
    html += form(
      securityPageFormPath(forms.slug, 'findings', id, 'comment'),
      textArea('text', `sec-comment-${key}`, 'Comment', SECURITY_COMMENT_MAX_CHARS),
      'Add comment',
    );
  }
  return html;
}

function findingBlock(
  finding: SecurityFindingView,
  full: boolean,
  forms: FindingForms | null = null,
  events?: ReadonlyArray<SecurityFindingEventView>,
): string {
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
    securityTraceLines(finding.trace)?.join('\n') ?? finding.trace,
  )}${detailField('Evidence', finding.evidence)}${detailField(
    'Conditions',
    finding.conditions,
  )}${detailField('Suggested fix', finding.fix)}${resolution}${timelineField(events)}${findingForms(
    finding,
    forms,
  )}</details>`;
}

/** Says so when a list is cut, and where the rest is. */
function cutNote(shown: number, total: number): string {
  return shown < total
    ? `<p class="void-auth-note">${esc(
        `Showing ${shown} of ${total}. See the rest with: void project security list`,
      )}</p>`
    : '';
}

function findingList(
  heading: string,
  findings: ReadonlyArray<SecurityFindingView>,
  full: boolean,
  total: number,
  forms: FindingForms | null = null,
  timelines?: SecurityPageData['timelines'],
): string {
  if (findings.length === 0) {
    return '';
  }
  return `<div class="void-auth-section"><h2>${esc(heading)}</h2><div class="sec-list">${findings
    .map((finding) =>
      findingBlock(
        finding,
        full,
        forms,
        typeof finding.findingId === 'string' ? timelines?.get(finding.findingId) : undefined,
      ),
    )
    .join('')}</div>${cutNote(findings.length, total)}</div>`;
}

/**
 * `skipped:budget` copy (spec §11.4, §16.3), by the cap that skipped the scan. A cap raised
 * since then says the next deploy is scanned; readers get no amounts.
 */
function budgetSkipCopy(
  cause: SecurityScanView['budgetCause'],
  budget: Status['budget'],
  model: string | null,
): string {
  if (!budget) {
    return 'Not scanned: the monthly scan budget is used up.';
  }
  const resets = `Resets ${day(budget.resetsAt)}.`;
  const reserve = budget.scanReserveUsd;
  // A row with no cause (none is expected) reads as the cap its numbers point to.
  const known =
    cause ??
    (budget.capUsd !== null && budget.spentUsd >= budget.capUsd ? 'project_cap' : 'platform_cap');
  switch (known) {
    case 'platform_cap':
      return `Not scanned: the platform's monthly scan budget is used up. ${resets} Your platform admin can raise it.`;
    case 'platform_reserve':
      return `Not scanned: one scan with ${model ?? 'this model'} can cost${reserve === null ? '' : ` up to ${usd(reserve)},`} more than is left of the platform's monthly scan budget. Ask your platform admin, or pick a cheaper model.`;
    case 'project_reserve':
      if (budget.capUsd !== null) {
        return `Not scanned: one scan with ${model ?? 'this model'} can cost${reserve === null ? '' : ` up to ${usd(reserve)},`} more than is left of this project's monthly scan budget (${usd(Math.max(0, budget.capUsd - budget.spentUsd))} of ${usd(budget.capUsd)}). Raise the cap or pick a cheaper model.`;
      }
      return 'Not scanned: one scan costs more than was left of the monthly scan budget. The cap was removed since; the next deploy is scanned.';
    case 'project_cap':
      if (budget.capUsd === null) {
        return 'Not scanned: the monthly scan budget was used up. The cap was removed since; the next deploy is scanned.';
      }
      if (budget.spentUsd < budget.capUsd) {
        return `Not scanned: this project's monthly scan budget was used up. It was raised since (${usd(budget.spentUsd)} of ${usd(budget.capUsd)} used); the next deploy is scanned.`;
      }
      return `Not scanned: this project's monthly scan budget is used up (${usd(budget.spentUsd)} of ${usd(budget.capUsd)}). ${resets}`;
  }
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
        return budgetSkipCopy(lastScan.budgetCause, budget, data.status.model.id);
      }
      if (reason === 'backlog') {
        return `Not scanned: the scan queue was full for 24 h. ${next}`;
      }
      if (reason === 'protected') {
        return 'Not scanned: this project is protected by Zero Trust and the platform scans public projects only.';
      }
      if (reason === SECURITY_PROJECT_POLICY_SKIP_REASON) {
        return 'Not scanned: a platform admin turned scans off for this project.';
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

/** The page's Model row: a blocked or unknown pick, a third-party model, or a pending default. */
export function modelLine(data: SecurityPageData): string | null {
  const { model } = data.status;
  if (model.pickProblem) {
    // Spec §8.2: `Model @cf/… (your pick openai/gpt-6.1-sol is blocked by the platform admin)`.
    return `${model.id ?? 'none'} (${securityPickProblemNote(model.requested, model.pickProblem)})`;
  }
  if (model.thirdParty && model.id) {
    return `Scans run on ${model.id}, a third-party model: its provider's usage policy applies and it may refuse. See: void project security model`;
  }
  if (model.pendingDefault) {
    return `The platform default is ${model.pendingDefault}. Accept to use it: void project security model --default --accept-provider-notice`;
  }
  return null;
}

/** A bypass skips the scan only; with urgent findings open, resolving is the next step. */
function bypassOffered(data: SecurityPageData): boolean {
  const state = data.request?.state;
  return (
    data.status.urgent.count === 0 &&
    (state === 'waiting_scan' || state === 'held_no_result' || state === 'needs_deploy')
  );
}

function modelForm(data: SecurityPageData): string {
  const { model } = data.status;
  const { defaultModel, saved, defaultNotice, noticeVersion, choices } = data.modelChoices;
  // The saved choice, not the model in use: `''` only when the project follows the default.
  const picked = saved ?? '';
  const option = (value: string, label: string) =>
    `<option value="${esc(value)}"${value === picked ? ' selected' : ''}>${esc(label)}</option>`;
  let options = option('', `Platform default (${defaultModel})`);
  for (const choice of choices) {
    options += option(choice.id, `${choice.id} · ${choice.badges.join(' · ')}`);
  }
  // A saved pick that can no longer be chosen stays visible, so saving another field
  // does not hide what is set.
  if (picked && !choices.some((choice) => choice.id === picked)) {
    options += option(picked, `${picked} (cannot be picked now)`);
  }
  const notices = new Map<string, ReadonlyArray<string>>();
  for (const choice of choices) {
    if (choice.notice) {
      notices.set(choice.provider, choice.notice);
    }
  }
  // A third-party default waiting for the notice: show its text too, so the box below
  // never asks to accept a notice the page did not show.
  if (model.pendingDefault !== null && defaultNotice) {
    notices.set(defaultNotice.provider, defaultNotice.notice);
  }
  let notice = '';
  if (notices.size > 0) {
    notice =
      [...notices]
        .map(
          ([provider, lines]) =>
            `<details><summary>Provider notice: ${esc(provider)}</summary>${lines
              .map((line) => `<p>${esc(line)}</p>`)
              .join('')}</details>`,
        )
        .join('') +
      '<label class="sec-check"><input type="checkbox" name="acceptProviderNotice" value="1">' +
      '<span>I have read the provider notice. Code from this project may be sent to that provider.</span></label>' +
      `<input type="hidden" name="noticeVersion" value="${noticeVersion}">`;
  }
  return form(
    securityPageFormPath(data.slug, 'model'),
    `<label for="sec-model">Scan model</label><select id="sec-model" name="model">${options}</select>` +
      notice,
    'Save model',
  );
}

function budgetForm(data: SecurityPageData): string {
  const budget = data.status.budget;
  if (!budget) {
    return '';
  }
  const ceiling =
    budget.ceilingUsd === null ? '' : ` The most you can set is ${usd(budget.ceilingUsd)}.`;
  return form(
    securityPageFormPath(data.slug, 'budget'),
    '<label for="sec-budget">Monthly scan budget for this project (USD)</label>' +
      '<input id="sec-budget" name="usd" inputmode="decimal" autocomplete="off" placeholder="100">' +
      `<p class="void-auth-note">${esc(`Leave it empty to remove this project's own cap.${ceiling}`)}</p>`,
    'Save budget',
  );
}

function bypassForm(data: SecurityPageData): string {
  return form(
    securityPageFormPath(data.slug, 'bypass'),
    textArea('reason', 'sec-bypass-reason', 'Why skip the scan', SECURITY_BYPASS_REASON_MAX_CHARS) +
      '<label class="sec-check"><input type="checkbox" name="confirm" value="1" required>' +
      '<span>Make the project public without a passing security scan. The bypass and its reason are recorded, and platform admins get an email.</span></label>',
    'Bypass the scan',
  );
}

function noticeBlock(notice: SecurityPageNotice | null): string {
  if (!notice) {
    return '';
  }
  return `<div class="${notice.kind === 'ok' ? 'sec-ok' : 'sec-banner'}" role="status"><p>${esc(
    notice.text,
  )}</p></div>`;
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

export function renderSecurityPage(
  data: SecurityPageData,
  notice: SecurityPageNotice | null = null,
): string {
  const { status, slug, role } = data;
  const settings = hasProjectCapability(role, 'settings');
  const full = hasProjectCapability(role, 'deploy');
  const head =
    `<div class="void-auth-lead"><h1 id="void-auth-title">${esc(slug)} · Security</h1></div>` +
    noticeBlock(notice);
  // Spec §5.4 (Any → Off): findings stay listed, and read, comment and resolve still work.
  // Only the scan settings and the bypass go, since no scan runs.
  const off = status.policy.mode === 'disabled';
  const forms: FindingForms | null = full
    ? { slug, comment: hasProjectCapability(role, 'configure'), resolve: settings }
    : null;

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
  if (!off) {
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
  }
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
      findingList(
        'Urgent (confirmed critical or high)',
        urgentRows,
        true,
        urgent.count,
        forms,
        data.timelines,
      ) +
      findingList(`Other open: ${otherTotal}`, otherRows, true, otherTotal, forms, data.timelines) +
      findingList(
        `Leads (need a human look): ${leadsTotal}`,
        leads,
        true,
        leadsTotal,
        forms,
        data.timelines,
      ) +
      findingList(
        `Resolved: ${resolvedTotal}`,
        data.resolved,
        true,
        resolvedTotal,
        forms,
        data.timelines,
      );
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
    if (!off) {
      commands.push('void project security budget --usd 100');
    }
    if (!off && bypassOffered(data)) {
      commands.push('void project zero-trust bypass --reason "…"');
    }
  } else if (full) {
    commands.push(`void project security comment ${firstUrgent} "…"`);
  }
  const help =
    (full && !settings ? '<p>A project admin or owner can resolve these.</p>' : '') +
    (commands.length > 0
      ? '<p class="void-auth-note">Or from the CLI:</p>' + code(commands.join('\n'))
      : '');

  let settingsBlock = '';
  if (settings && !off) {
    settingsBlock =
      '<div class="void-auth-section"><h2>Settings</h2>' +
      modelForm(data) +
      budgetForm(data) +
      '</div>';
    if (bypassOffered(data)) {
      settingsBlock +=
        '<div class="void-auth-section"><h2>Public request</h2>' + bypassForm(data) + '</div>';
    }
  }

  const notes =
    '<p class="void-auth-note">AI review can be wrong. "No findings" does not mean "no bugs". ' +
    'Security findings never block deploys. With "Scan before a project goes public" on, they hold a public request.</p>';

  return (
    PAGE_STYLE +
    head +
    (off ? `<p>${esc(status.policy.reason)}</p>` : '') +
    banner +
    `<dl class="void-auth-identity">${rows.join('')}</dl>` +
    lists +
    scans +
    settingsBlock +
    help +
    notes
  );
}
