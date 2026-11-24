/**
 * Copy of the security emails (spec §12). Pure: data in, `{subject, ...}` out, so the
 * wording is tested without a mail binding. `email.ts` sends it.
 *
 * Content rules: titles, severity and file path only. No code, trace, line or exploit
 * detail (email leaves the platform and can be forwarded). Model text is cut to 120
 * characters, human text (a reason or comment) to 300, and neither is ever a link.
 */

import type { SecuritySeverity } from './schema.ts';

const NANO_USD_PER_CENT = 10_000_000;

/** `$1,000.00` from nano-dollars (same as `formatSecurityUsd`; kept here so the copy has no runtime imports). */
function formatSecurityUsd(nanoUsd: number): string {
  const cents = Math.max(0, Math.round(nanoUsd / NANO_USD_PER_CENT));
  const dollars = Math.floor(cents / 100);
  return `$${dollars.toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
}

export const SECURITY_EMAIL_MODEL_TEXT_MAX = 120;
export const SECURITY_EMAIL_HUMAN_TEXT_MAX = 300;
/** Findings listed in one email; the rest is "and N more". */
export const SECURITY_EMAIL_MAX_FINDINGS = 20;

export type SecurityEmailContent = Readonly<{
  subject: string;
  /** First paragraph. */
  intro: string;
  /** Lines shown in a monospaced block. */
  details: ReadonlyArray<string>;
  /** Paragraphs after the block. */
  notes: ReadonlyArray<string>;
  /** Lines for the second monospaced block (the commands to run). */
  actions: ReadonlyArray<string>;
  footer: string;
  /** The project whose sign-in-free page is linked; none for the platform cap email. */
  pageSlug: string | null;
}>;

/** Why one person gets one email; the footer names it. */
export type SecurityEmailReason =
  | Readonly<{ kind: 'owner_admin' }>
  | Readonly<{ kind: 'author'; deploymentIds: ReadonlyArray<string> }>
  | Readonly<{ kind: 'requester' }>
  | Readonly<{ kind: 'installation_admin' }>;

export function securityEmailFooter(
  reason: SecurityEmailReason,
  project: string | null,
  platform: string,
): string {
  switch (reason.kind) {
    case 'owner_admin':
      return `You get this because you are an owner or admin of ${project}.`;
    case 'author':
      return `You get this because you deployed ${reason.deploymentIds.join(', ')} to ${project}.`;
    case 'requester':
      return `You get this because you asked for ${project} to go public.`;
    case 'installation_admin':
      return `You get this because you are an administrator of ${platform}.`;
  }
}

/** Drops control characters and folds line breaks, so a model text stays on one line. */
function oneLine(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n' || char === '\r' || char === '\t') {
      out += ' ';
    } else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim();
}

/** At most `max` characters (not UTF-16 units), with an ellipsis when cut. */
export function cutSecurityEmailText(text: string, max: number): string {
  const chars = [...oneLine(text)];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `Nov 10, 14:02 UTC`. */
export function formatSecurityStamp(ms: number): string {
  const date = new Date(ms);
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${hour}:${minute} UTC`;
}

/** `Nov 2`, for a resolve date. */
export function formatSecurityDay(ms: number): string {
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'informational'] as const;

export type SecurityEmailFinding = Readonly<{
  /** `F-12`. */
  label: string;
  severity: SecuritySeverity;
  title: string;
  file: string | null;
  urgent: boolean;
  /** `possible duplicate of F-12, resolved false positive on Nov 2`. */
  duplicateNote: string | null;
}>;

function findingLines(findings: ReadonlyArray<SecurityEmailFinding>, indent = '  '): Array<string> {
  const rows = findings.map((finding) => ({
    severity: finding.severity.toUpperCase(),
    label: finding.label,
    title: cutSecurityEmailText(finding.title, SECURITY_EMAIL_MODEL_TEXT_MAX),
    file:
      finding.file === null
        ? ''
        : cutSecurityEmailText(finding.file, SECURITY_EMAIL_MODEL_TEXT_MAX),
    tail: [
      finding.urgent ? '(urgent)' : '',
      finding.duplicateNote
        ? `(${cutSecurityEmailText(finding.duplicateNote, SECURITY_EMAIL_MODEL_TEXT_MAX)})`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  }));
  const severityWidth = Math.max(0, ...rows.map((row) => row.severity.length));
  const labelWidth = Math.max(0, ...rows.map((row) => row.label.length));
  const titleWidth = Math.max(0, ...rows.map((row) => row.title.length));
  const fileWidth = Math.max(0, ...rows.map((row) => row.file.length));
  return rows.map((row) =>
    `${indent}${pad(row.severity, severityWidth)}  ${pad(row.label, labelWidth)}  ${pad(row.title, titleWidth)}  ${pad(row.file, fileWidth)}  ${row.tail}`.trimEnd(),
  );
}

function bracket(platform: string): string {
  return `[${platform}]`;
}

// ---------------------------------------------------------------------------
// Findings, reopen
// ---------------------------------------------------------------------------

export type SecurityFindingsEmailData = Readonly<{
  platform: string;
  slug: string;
  /** Scans merged into this email (30-minute cooldown). */
  scanCount: number;
  deployment: Readonly<{ id: string; commit: string | null; at: number | null }> | null;
  tier: 'source_diff' | 'built_diff' | 'full' | null;
  baseDeploymentId: string | null;
  filesScanned: number | null;
  coverage: 'complete' | 'partial' | null;
  model: string | null;
  /** `Anthropic` for a third-party model, else `null`. */
  provider: string | null;
  findings: ReadonlyArray<SecurityEmailFinding>;
  moreFindings: number;
  leads: number;
}>;

const TIER_LABELS = {
  source_diff: 'source diff',
  built_diff: 'built diff',
  full: 'full scan',
} as const;

export function composeSecurityFindingsEmail(
  data: SecurityFindingsEmailData,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  const total = data.findings.length + data.moreFindings;
  const counts = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: data.findings.filter((finding) => finding.severity === severity).length,
  })).filter((entry) => entry.count > 0);
  // The list is cut at 20, so the counts name what the list shows when it is whole.
  const breakdown =
    data.moreFindings > 0
      ? ''
      : ` (${total === 1 ? counts[0]!.severity : counts.map((entry) => `${entry.count} ${entry.severity}`).join(', ')})`;
  const subject = `${bracket(data.platform)} ${data.slug}: ${total} new security ${plural(total, 'finding', 'findings')}${breakdown}`;

  const details: Array<string> = [];
  if (data.deployment) {
    const parts = [data.deployment.id];
    if (data.deployment.commit) {
      parts.push(`commit ${data.deployment.commit.slice(0, 7)}`);
    }
    if (data.deployment.at !== null) {
      parts.push(formatSecurityStamp(data.deployment.at));
    }
    details.push(`  ${pad('Deployment', 12)}${parts.join(' · ')}`);
  }
  const scanned: Array<string> = [];
  if (data.tier) {
    scanned.push(
      data.baseDeploymentId && data.tier !== 'full'
        ? `changes since ${data.baseDeploymentId}`
        : 'whole project',
    );
    scanned.push(TIER_LABELS[data.tier]);
  }
  if (data.filesScanned !== null) {
    scanned.push(`${data.filesScanned} ${plural(data.filesScanned, 'file', 'files')}`);
  }
  if (data.coverage) {
    scanned.push(data.coverage);
  }
  if (scanned.length > 0) {
    details.push(`  ${pad('Scanned', 12)}${scanned.join(' · ')}`);
  }
  if (data.model) {
    details.push(`  ${pad('Model', 12)}${data.model}`);
    if (data.provider) {
      details.push(
        `  ${pad('', 12)}Run by ${data.provider}: its usage policy applies and it may refuse.`,
      );
    }
  }
  details.push('', ...findingLines(data.findings));
  if (data.moreFindings > 0) {
    details.push(
      `  and ${data.moreFindings} more: void project security list --project ${data.slug}`,
    );
  }

  const notes: Array<string> = [];
  if (data.leads > 0) {
    notes.push(
      `Also ${data.leads} new ${plural(data.leads, 'lead', 'leads')} that ${plural(data.leads, 'needs', 'need')} a human look: void project security list --leads`,
    );
  }
  const urgent = data.findings.filter((finding) => finding.urgent).map((finding) => finding.label);
  if (urgent.length > 0) {
    notes.push(
      `${urgent.join(' and ')} ${plural(urgent.length, 'is', 'are')} urgent: confirmed critical or high. Please fix ${plural(urgent.length, 'it', 'them')}, then a project admin or owner resolves ${plural(urgent.length, 'it', 'them')}.`,
    );
  }
  notes.push('AI review can be wrong. Check each finding before you act on it.');
  return {
    subject,
    intro:
      data.scanCount > 1
        ? `${data.scanCount} security scans of ${data.slug} found new issues.`
        : `A security scan of ${data.slug} found new issues.`,
    details,
    notes,
    actions: [
      `Review:  void project security open --project ${data.slug}`,
      `Or run:  void project security list --project ${data.slug}`,
    ],
    footer: securityEmailFooter(reason, data.slug, data.platform),
    pageSlug: data.slug,
  };
}

export type SecurityReopenEmailData = Readonly<{
  platform: string;
  slug: string;
  finding: Pick<SecurityEmailFinding, 'label' | 'severity' | 'title' | 'file'>;
  /** `owner`, `admin` or `installation_admin`. */
  actorRole: string | null;
  comment: string | null;
}>;

/** The role a person acted in; the person is never named in a project-side email. */
export function securityActorRoleLabel(role: string | null): string {
  switch (role) {
    case 'owner':
      return 'the project owner';
    case 'admin':
      return 'a project admin';
    case 'installation_admin':
      return 'a platform admin';
    default:
      return 'a project member';
  }
}

export function composeSecurityReopenEmail(
  data: SecurityReopenEmailData,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  const notes = [
    `Reopened by ${securityActorRoleLabel(data.actorRole)}${
      data.comment
        ? `: "${cutSecurityEmailText(data.comment, SECURITY_EMAIL_HUMAN_TEXT_MAX)}"`
        : '.'
    }`,
    `${data.finding.label} is urgent: confirmed critical or high. Please fix it, then a project admin or owner resolves it.`,
    'AI review can be wrong. Check the finding before you act on it.',
  ];
  return {
    subject: `${bracket(data.platform)} ${data.slug}: ${data.finding.label} reopened (${data.finding.severity})`,
    intro: `A security finding in ${data.slug} was reopened.`,
    details: findingLines([{ ...data.finding, urgent: true, duplicateNote: null }]),
    notes,
    actions: [
      `Review:  void project security open --project ${data.slug}`,
      `Or run:  void project security list --project ${data.slug}`,
    ],
    footer: securityEmailFooter(reason, data.slug, data.platform),
    pageSlug: data.slug,
  };
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export type SecurityCapRaise =
  | Readonly<{ kind: 'project_admin'; usdArgument: string; limitUsd: string | null }>
  /** `projectId`: the operator route takes the project id, not the slug. */
  | Readonly<{ kind: 'platform_admin'; usdArgument: string; projectId: string }>;

export type SecurityProjectCapEmailData = Readonly<{
  platform: string;
  slug: string;
  percent: 80 | 100;
  spentNano: number;
  capNano: number;
  /** `Dec 1`. */
  resetLabel: string;
  raise: SecurityCapRaise;
}>;

export function composeSecurityProjectCapEmail(
  data: SecurityProjectCapEmailData,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  const used = `${formatSecurityUsd(data.spentNano)} of ${formatSecurityUsd(data.capNano)}`;
  const raise =
    data.raise.kind === 'project_admin'
      ? `Raise it:  void project security budget --usd ${data.raise.usdArgument}${
          data.raise.limitUsd
            ? `            (project admin, up to the platform limit of ${data.raise.limitUsd})`
            : '            (project admin)'
        }`
      : `Raise it:  void platform security budget --project ${data.raise.projectId} --usd ${data.raise.usdArgument}   (platform admin, any amount)`;
  return {
    subject:
      data.percent === 80
        ? `${bracket(data.platform)} ${data.slug}: 80% of the monthly security scan budget used (${used})`
        : `${bracket(data.platform)} ${data.slug}: monthly security scan budget used up, new deploys are not scanned until ${data.resetLabel}`,
    intro:
      data.percent === 80
        ? `${data.slug} has used 80% of its monthly security scan budget (${used}).`
        : `Budget used up: deploys still go out; they are not scanned until ${data.resetLabel} or until the cap is raised.`,
    details: [],
    notes: [],
    actions: [raise],
    footer: securityEmailFooter(reason, data.slug, data.platform),
    pageSlug: data.slug,
  };
}

export type SecurityPlatformCapEmailData = Readonly<{
  platform: string;
  percent: 80 | 100;
  spentNano: number;
  capNano: number;
  resetLabel: string;
  raiseUsdArgument: string;
}>;

export function composeSecurityPlatformCapEmail(
  data: SecurityPlatformCapEmailData,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  const used = `${formatSecurityUsd(data.spentNano)} of ${formatSecurityUsd(data.capNano)}`;
  return {
    subject:
      data.percent === 80
        ? `${bracket(data.platform)} Platform: 80% of the monthly security scan budget used (${used})`
        : `${bracket(data.platform)} Platform: monthly security scan budget used up, new deploys are not scanned until ${data.resetLabel}`,
    intro:
      data.percent === 80
        ? `The platform has used 80% of its monthly security scan budget (${used}).`
        : `Budget used up: deploys still go out; they are not scanned until ${data.resetLabel} or until the cap is raised.`,
    details: [],
    notes: [],
    actions: [`Raise it:  void platform security budget --platform-usd ${data.raiseUsdArgument}`],
    footer: securityEmailFooter(reason, null, data.platform),
    pageSlug: null,
  };
}

// ---------------------------------------------------------------------------
// Public requests (spec §5.5) and bypasses
// ---------------------------------------------------------------------------

export type SecurityPublicHeldState = 'held_findings' | 'held_no_result' | 'needs_deploy';

export type SecurityPublicEmailData = Readonly<{
  platform: string;
  slug: string;
  /** `a project admin`, `the project owner`, `a platform admin`. */
  requestedBy: string;
  requestedAt: number;
  /** `dpl_9a1d · full scan (first scan) · complete`, or `null` with no gate scan. */
  scanned: string | null;
  blockers: ReadonlyArray<SecurityEmailFinding>;
  blockerCount: number;
}>;

const BYPASS_LINE = 'void project zero-trust bypass --reason "…"';

export function composeSecurityPublicHeldEmail(
  data: SecurityPublicEmailData &
    Readonly<{
      state: SecurityPublicHeldState;
      /** `refused by anthropic/claude-opus-5.5`, for the no-result subject. */
      noResultReason: string | null;
    }>,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  const details = [
    `  ${pad('Requested', 12)}by ${data.requestedBy} · ${formatSecurityStamp(data.requestedAt)}`,
  ];
  if (data.scanned) {
    details.push(`  ${pad('Scanned', 12)}${data.scanned}`);
  }
  if (data.state === 'held_findings' && data.blockers.length > 0) {
    const lines = findingLines(
      data.blockers.map((finding) => ({ ...finding, urgent: false })),
      '',
    );
    lines.forEach((line, index) => {
      details.push(`  ${pad(index === 0 ? 'Blocking' : '', 12)}${line}`);
    });
    if (data.blockerCount > data.blockers.length) {
      details.push(`  ${pad('', 12)}and ${data.blockerCount - data.blockers.length} more`);
    }
  }
  let subject: string;
  let notes: Array<string>;
  let actions: Array<string>;
  if (data.state === 'held_findings') {
    subject = `${bracket(data.platform)} ${data.slug} stays protected: ${data.blockerCount} urgent security ${plural(data.blockerCount, 'finding', 'findings')} must be resolved first`;
    // Never a bypass: it is refused while an urgent finding is open.
    notes = [
      `Resolve ${plural(data.blockerCount, 'it', 'them')}, then ${data.slug} goes public. A fix needs a new deploy that scans clean.`,
    ];
    actions = [`Review:  void project zero-trust status --project ${data.slug}`];
  } else if (data.state === 'held_no_result') {
    subject = `${bracket(data.platform)} ${data.slug} stays protected: the security scan did not finish${data.noResultReason ? ` (${data.noResultReason})` : ''}`;
    notes = [
      `${data.slug} stays protected by Zero Trust. Ask again, deploy again, or bypass the scan.`,
    ];
    actions = [
      `Review:  void project zero-trust status --project ${data.slug}`,
      `Bypass:  ${BYPASS_LINE}`,
    ];
  } else {
    subject = `${bracket(data.platform)} ${data.slug} stays protected: deploy again so the live code can be scanned`;
    notes = [
      `${data.slug} goes public when the scan of the next deploy is clean. An unchanged static redeploy does not count: change something, or bypass the scan.`,
    ];
    actions = [
      `Review:  void project zero-trust status --project ${data.slug}`,
      `Bypass:  ${BYPASS_LINE}`,
    ];
  }
  return {
    subject,
    intro: `The request to make ${data.slug} public is on hold.`,
    details,
    notes,
    actions,
    footer: securityEmailFooter(reason, data.slug, data.platform),
    pageSlug: data.slug,
  };
}

export function composeSecurityNowPublicEmail(
  data: Readonly<{ platform: string; slug: string; how: 'passed' | 'bypassed' }>,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  return {
    subject: `${bracket(data.platform)} ${data.slug} is now public (security scan ${data.how})`,
    intro:
      data.how === 'passed'
        ? `${data.slug} is public: the security scan passed (nothing urgent found).`
        : `${data.slug} is public: a project admin bypassed the security scan. Your platform admins were told.`,
    details: [],
    notes: [],
    actions: [`Review:  void project security status --project ${data.slug}`],
    footer: securityEmailFooter(reason, data.slug, data.platform),
    pageSlug: data.slug,
  };
}

export function composeSecurityPublicCanceledEmail(
  data: Readonly<{ platform: string; slug: string; cause: 'gate_off' | 'policy_off' }>,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  return {
    subject: `${bracket(data.platform)} ${data.slug} public request canceled: it stays protected`,
    intro:
      data.cause === 'gate_off'
        ? `Public request canceled: your platform admin turned off "Scan before a project goes public". ${data.slug} stays protected.`
        : `Public request canceled: your platform admin turned off security audits. ${data.slug} stays protected.`,
    details: [],
    notes: [],
    actions: ['To make it public now:  void project zero-trust public'],
    footer: securityEmailFooter(reason, data.slug, data.platform),
    pageSlug: data.slug,
  };
}

export type SecurityBypassEmailData = Readonly<{
  platform: string;
  slug: string;
  /** `alice@example.com`, or the login when the account has no email. */
  actor: string;
  /** `project admin`, `owner` or `installation admin`. */
  actorRole: string;
  at: number;
  reason: string;
  /** What the bypass skipped: `the scan did not finish (timed out)`. */
  skipped: string;
  deploymentId: string;
  /** `F-15`, for `fixed` claims no scan has checked yet. */
  uncheckedFixes: ReadonlyArray<string>;
}>;

export function composeSecurityBypassEmail(
  data: SecurityBypassEmailData,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  const roleWord =
    data.actorRole === 'owner'
      ? 'the owner'
      : `${data.actorRole === 'installation admin' ? 'an' : 'a'} ${data.actorRole}`;
  return {
    subject: `${bracket(data.platform)} ${data.slug}: security scan bypassed by ${roleWord}`,
    intro: `The security scan of ${data.slug} was bypassed.`,
    details: [
      `  ${pad('Who', 9)}${data.actor} (${data.actorRole}) · ${formatSecurityStamp(data.at)}`,
      `  ${pad('Reason', 9)}"${cutSecurityEmailText(data.reason, SECURITY_EMAIL_HUMAN_TEXT_MAX)}"`,
      `  ${pad('Skipped', 9)}${data.skipped} · deployment ${data.deploymentId}`,
      `  ${pad('Open', 9)}no urgent finding${
        data.uncheckedFixes.length > 0
          ? ` · ${data.uncheckedFixes.length} ${plural(data.uncheckedFixes.length, 'fix', 'fixes')} not yet checked by a scan (${data.uncheckedFixes.join(', ')})`
          : ''
      }`,
    ],
    notes: [`${data.slug} is going public now. The bypass is recorded:`],
    actions: [`void platform security bypasses --project ${data.slug}`],
    footer: securityEmailFooter(reason, data.slug, data.platform),
    pageSlug: null,
  };
}

// ---------------------------------------------------------------------------
// Failure streaks and the weekly digest (Phase 2, M26)
// ---------------------------------------------------------------------------

export type SecurityStreakScanLine = Readonly<{
  id: string;
  deploymentId: string | null;
  /** `refused by anthropic/claude-opus-5.5`, `timed out`, `bad output`, … */
  outcome: string;
  at: number | null;
}>;

export type SecurityProjectStreakEmailData = Readonly<{
  platform: string;
  slug: string;
  failures: number;
  /** Newest first, at most a few. */
  scans: ReadonlyArray<SecurityStreakScanLine>;
  /** The third-party model that refused, when the newest failure is a refusal. */
  refusedModel: string | null;
  /** The `@cf` model to switch to in that case. */
  cfModel: string | null;
  /** The platform's re-scan on the `@cf` default is on. */
  fallbackOn: boolean;
}>;

export function composeSecurityProjectStreakEmail(
  data: SecurityProjectStreakEmailData,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  const details = data.scans.map((scan) =>
    [
      `  ${pad(scan.id, 22)}`,
      pad(scan.deploymentId ?? '', 22),
      pad(cutSecurityEmailText(scan.outcome, 60), 40),
      scan.at === null ? '' : formatSecurityStamp(scan.at),
    ]
      .join(' ')
      .trimEnd(),
  );
  if (data.failures > data.scans.length) {
    details.push(`  and ${data.failures - data.scans.length} more`);
  }
  const notes: Array<string> = [];
  if (data.refusedModel && data.cfModel) {
    notes.push(
      `${data.refusedModel} refused to review this code. A project admin or owner can switch the model: void project security model ${data.cfModel} --project ${data.slug}`,
    );
    if (!data.fallbackOn) {
      notes.push(
        `A platform admin can also re-scan once on the @cf default after a refusal: void platform security fallback on`,
      );
    }
  }
  notes.push('Deploys are not blocked. The next scan covers every change since the last good one.');
  return {
    subject: `${bracket(data.platform)} ${data.slug}: ${data.failures} security scans in a row did not finish`,
    intro: `The last ${data.failures} security scans of ${data.slug} did not succeed, so its newest code has no security result yet.`,
    details,
    notes,
    actions: [
      `See them:   void project security scans --project ${data.slug}`,
      `Scan again: void project security scan --project ${data.slug}`,
    ],
    footer: securityEmailFooter(reason, data.slug, data.platform),
    pageSlug: data.slug,
  };
}

const INSTALLATION_REASON_LABELS: Readonly<Record<string, string>> = {
  credits: 'no AI credits left',
  infrastructure: 'scanner or container error',
  backlog: 'waited over 24 hours in the queue',
};

export type SecurityInstallationStreakEmailData = Readonly<{
  platform: string;
  /** Scans that ended in the last 24 hours. */
  ended: number;
  /** Of those, failures with a platform cause. */
  failed: number;
  byReason: Readonly<Record<string, number>>;
}>;

export function composeSecurityInstallationStreakEmail(
  data: SecurityInstallationStreakEmailData,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  const reasons = Object.entries(data.byReason).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return {
    subject: `${bracket(data.platform)} Platform: ${data.failed} of ${data.ended} security scans failed in the last 24 hours`,
    intro: `Security scans are failing for a platform reason, not because of the projects' code. Deploys still go out, without a security result.`,
    details: reasons.map(
      ([key, count]) =>
        `  ${pad(String(count), 6)}${INSTALLATION_REASON_LABELS[key] ?? key.split('_').join(' ')}`,
    ),
    notes: data.byReason.credits
      ? [
          'Add Workers AI credits on the Cloudflare account, then the next deploys are scanned again.',
        ]
      : [],
    actions: [
      'Status:  void platform security status',
      'Scans:   void platform security scans --status failed',
    ],
    footer: securityEmailFooter(reason, null, data.platform),
    pageSlug: null,
  };
}

export type SecurityDigestEmailData = Readonly<{
  platform: string;
  /** `Nov 9 – Nov 15`. */
  weekLabel: string;
  scans: Readonly<{
    ended: number;
    succeeded: number;
    projectFailures: number;
    installationFailures: number;
    budgetSkips: number;
  }>;
  newFindings: Readonly<{
    critical: number;
    high: number;
    medium: number;
    low: number;
    leads: number;
  }>;
  resolvedFindings: number;
  openUrgentFindings: number;
  projectsWithUrgentFindings: number;
  projectsWithFailureStreaks: number;
  openPublicRequests: number;
  bypasses: number;
}>;

export function composeSecurityDigestEmail(
  data: SecurityDigestEmailData,
  reason: SecurityEmailReason,
): SecurityEmailContent {
  const found = data.newFindings;
  const newTotal = found.critical + found.high + found.medium + found.low;
  const row = (label: string, value: string) => `  ${pad(label, 26)}${value}`;
  const details = [
    row(
      'Scans',
      `${data.scans.ended} ended: ${data.scans.succeeded} succeeded, ${data.scans.projectFailures} failed (project), ${data.scans.installationFailures} failed (platform), ${data.scans.budgetSkips} skipped (budget)`,
    ),
    row(
      'New findings',
      `${newTotal}: ${found.critical} critical, ${found.high} high, ${found.medium} medium, ${found.low} low; ${found.leads} ${plural(found.leads, 'lead', 'leads')}`,
    ),
    row('Resolved', String(data.resolvedFindings)),
    row(
      'Urgent and open now',
      `${data.openUrgentFindings} in ${data.projectsWithUrgentFindings} ${plural(data.projectsWithUrgentFindings, 'project', 'projects')}`,
    ),
    row(
      'Failure streaks now',
      `${data.projectsWithFailureStreaks} ${plural(data.projectsWithFailureStreaks, 'project', 'projects')}`,
    ),
    row('Open public requests', String(data.openPublicRequests)),
    row('Scan bypasses', String(data.bypasses)),
  ];
  return {
    subject: `${bracket(data.platform)} Platform: weekly security summary (${data.weekLabel})`,
    intro: `Security audits on ${data.platform} in the week ${data.weekLabel} (UTC).`,
    details,
    notes: [],
    actions: [
      'Urgent:  void platform security findings --urgent',
      'Scans:   void platform security scans',
    ],
    footer: securityEmailFooter(reason, null, data.platform),
    pageSlug: null,
  };
}
