import { PlatformApiError } from './client.ts';
import type { PlatformClient } from './client.ts';
import type { CliLogger } from './log-file.ts';
import { budgetAhead, budgetCause, budgetSkipCopy, cleanLine } from './project-security.ts';
import type {
  ProjectSecurityStatus,
  SecurityBudgetCause,
  SecurityScanSummary,
  SecurityUrgentFinding,
} from './security-api-types.ts';

/** The read is best-effort: it may add this long to CLI exit, never to the deploy. */
const NOTICE_TIMEOUT_MS = 5000;
const MAX_ROWS = 5;
const MAX_TITLE = 120;
const PROVIDERS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  mistral: 'Mistral',
};

export type DeploySecurityNoticeInput = {
  client: PlatformClient;
  projectId: string;
  slug: string;
  deploymentId: string;
  cliLog?: CliLogger;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  write?: (line: string) => void;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** CI logs can be public: print counts and ids only. */
function inCi(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI;
  return (
    (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false') || Boolean(env.GITHUB_ACTIONS)
  );
}

function providerName(model: string): string {
  const prefix = model.startsWith('@') ? '' : model.split('/')[0]!;
  return PROVIDERS[prefix] ?? (prefix ? cleanLine(prefix) : 'a third-party provider');
}

/** `Not security-scanned: …` for a budget skip (spec §6.5, §16.3). */
function budgetLines(
  cause: SecurityBudgetCause,
  status: ProjectSecurityStatus,
  projectId: string | undefined,
): Array<string> {
  const copy = budgetSkipCopy(cause, status.budget, status.model.id, projectId);
  if (copy.raised) {
    return [`  Not security-scanned: ${copy.why}. The next deploy is scanned.`];
  }
  const first = `  Not security-scanned: ${copy.why}.${copy.resets ? ` ${copy.resets}` : ''}`;
  if (copy.next === null) {
    return [status.budget ? `${first} Ask your platform admin.` : first];
  }
  return [first, `    ${copy.next}`];
}

function scanLines(
  slug: string,
  deploymentId: string,
  status: ProjectSecurityStatus,
  projectId: string | undefined,
): Array<string> {
  const { policy, lastScan, model, budget } = status;
  if (!lastScan || lastScan.deploymentId !== deploymentId) {
    return [];
  }
  const reason = lastScan.statusReason ?? '';
  // A protected project under `public` is out of scope, and its deploy says why.
  const protectedSkip = lastScan.status === 'skipped' && reason === 'protected';
  if (!policy.applies && !protectedSkip) {
    return [];
  }
  switch (lastScan.status) {
    case 'queued':
    case 'running':
    case 'pending_input': {
      // The cap is checked again when the scan starts; one used up now skips it then.
      const ahead = lastScan.status === 'running' ? null : budgetAhead(budget);
      if (ahead) {
        return budgetLines(ahead, status, projectId);
      }
      const lines = [
        `  Security scan queued · model ${cleanLine(model.id ?? lastScan.model ?? 'none')} · usually 5–15 min`,
      ];
      if (model.thirdParty && model.id) {
        lines.push(
          `    Run by ${providerName(model.id)}: its usage policy applies and it may refuse. See: void project security model`,
        );
      }
      if (model.pendingDefault) {
        lines.push(
          `    Platform default is ${cleanLine(model.pendingDefault)}. Accept to use it:`,
          '    void project security model --default --accept-provider-notice',
        );
      }
      if (status.publicRequest) {
        lines.push(
          `    ${slug} stays protected by Zero Trust until this scan passes (public request). void project zero-trust status`,
        );
      }
      lines.push('  Check it:  void project security status');
      return lines;
    }
    case 'skipped':
      if (reason === 'budget') {
        return budgetLines(budgetCause(lastScan, budget), status, projectId);
      }
      if (reason === 'protected') {
        return [
          '  Not security-scanned: project is protected by Zero Trust and the platform scans public projects only.',
        ];
      }
      return [];
    case 'succeeded':
      return reason === 'no_changes' && lastScan.baseDeploymentId
        ? [`  Security scan: no code changes since ${cleanLine(lastScan.baseDeploymentId)}.`]
        : [];
    default:
      return [];
  }
}

function failedScanLines(deploymentId: string, status: ProjectSecurityStatus): Array<string> {
  const { lastScan, lastSuccessfulScan, deploysSinceLastSuccess, policy } = status;
  // The newest scan is usually this deploy's own, just queued: warn about the one before.
  const prior = lastScan?.deploymentId === deploymentId ? (status.previousScan ?? null) : lastScan;
  if (!policy.applies || !prior || prior.deploymentId === deploymentId) {
    return [];
  }
  const why = failureWhy(prior);
  if (!why) {
    return [];
  }
  const lines = [
    `  Warning: the security scan of ${cleanLine(prior.deploymentId ?? 'the last deploy')} did not finish (${why}).`,
  ];
  if (lastSuccessfulScan?.deploymentId && deploysSinceLastSuccess && deploysSinceLastSuccess >= 2) {
    lines.push(
      `  ${deploysSinceLastSuccess} deploys since the last successful scan (${cleanLine(lastSuccessfulScan.deploymentId)}). This scan covers all changes since then.`,
    );
  }
  lines.push('  void project security scans');
  return lines;
}

function failureWhy(scan: SecurityScanSummary): string | null {
  switch (scan.status) {
    case 'refused':
      return 'refused by model';
    case 'timed_out':
      return 'timed out';
    case 'failed':
      return scan.failureCause === 'installation'
        ? 'a platform problem'
        : cleanLine(scan.statusReason ?? 'failed');
    case 'incomplete':
      return (scan.statusReason ?? '').startsWith('budget')
        ? 'the monthly scan budget ran out'
        : `partial: ${cleanLine(scan.statusReason ?? 'stopped early')}`;
    default:
      return null;
  }
}

function clip(text: string): string {
  const line = cleanLine(text);
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

function rowHint(finding: SecurityUrgentFinding): string {
  if (finding.possibleDuplicateOf) {
    const { id, resolution } = finding.possibleDuplicateOf;
    return `  (possible duplicate of ${cleanLine(id)}${resolution ? `, resolved ${cleanLine(resolution).split('_').join(' ')}` : ''})`;
  }
  return finding.notSeenInLatest ? '  (not seen in latest scan; may already be fixed)' : '';
}

/** Oldest first inside a severity; a missing or bad date keeps the server order. */
function firstSeen(finding: SecurityUrgentFinding): number {
  const time = finding.firstSeenAt ? Date.parse(finding.firstSeenAt) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

function urgentLines(slug: string, status: ProjectSecurityStatus, counts: boolean): Array<string> {
  const { urgent, publicRequest } = status;
  if (urgent.count <= 0) {
    return [];
  }
  const sorted = urgent.findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        Number(b.finding.severity === 'critical') - Number(a.finding.severity === 'critical') ||
        firstSeen(a.finding) - firstSeen(b.finding) ||
        a.index - b.index,
    )
    .map(({ finding }) => finding);
  const shown = sorted.slice(0, MAX_ROWS);
  const more = Math.max(0, urgent.count - shown.length);
  const parts = [
    urgent.counts.critical ? `${urgent.counts.critical} critical` : '',
    urgent.counts.high ? `${urgent.counts.high} high` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const plural = urgent.count === 1 ? 'finding is' : 'findings are';
  const ids = shown.map((finding) => cleanLine(finding.id));
  if (counts) {
    return [
      `  ⚠ ${urgent.count} urgent security ${plural} open (${parts})${ids.length ? `: ${ids.join(', ')}${more ? `, … and ${more} more` : ''}` : ''}`,
      '    Details are not printed in CI logs. Run: void project security list --urgent',
    ];
  }
  const lines = [
    `  ⚠ ${urgent.count} urgent security ${plural} open in ${cleanLine(slug)} (${parts}):`,
  ];
  for (const finding of shown) {
    const place = finding.file
      ? `${clip(finding.file)}${finding.line ? `:${finding.line}` : ''}`
      : '';
    lines.push(
      `    ${[
        cleanLine(finding.id).padEnd(5),
        cleanLine(finding.severity ?? '-').padEnd(8),
        finding.title === undefined ? '' : clip(finding.title),
        place,
      ]
        .join(' ')
        .trimEnd()}${rowHint(finding)}`,
    );
  }
  if (more > 0) {
    lines.push(`    … and ${more} more:  void project security list --urgent`);
  }
  lines.push(
    '  They come from earlier scans and still need a fix. Your deploy went out.',
    `    Read:  void project security show ${ids[0] ?? 'F-1'}`,
    '    Page:  void project security open',
    // The server says whether this caller may resolve (`settings`); older platforms do not.
    status.canResolve === true
      ? `    Fixed?  void project security resolve ${ids[0] ?? 'F-1'} --reason fixed --comment "…"`
      : '    A project admin or owner can resolve them.',
  );
  if (publicRequest) {
    lines.push(
      `    ${cleanLine(slug)} stays protected by Zero Trust until these are resolved (public request).`,
    );
  }
  return lines;
}

/** Everything the notice prints for one security reply; empty when there is nothing to say. */
export function formatDeploySecurityNotice(
  input: { slug: string; deploymentId: string; projectId?: string; env?: NodeJS.ProcessEnv },
  status: ProjectSecurityStatus,
): Array<string> {
  if (status.policy.mode === 'disabled' || input.slug.startsWith('preview-')) {
    return [];
  }
  const counts = status.urgent.detail === 'counts' || inCi(input.env ?? process.env);
  const groups = [
    scanLines(input.slug, input.deploymentId, status, input.projectId),
    failedScanLines(input.deploymentId, status),
    urgentLines(input.slug, status, counts),
  ].filter((group) => group.length > 0);
  return groups.flatMap((group, index) => (index === 0 ? group : ['', ...group]));
}

function usable(value: unknown): value is ProjectSecurityStatus {
  return (
    isObject(value) &&
    isObject(value.policy) &&
    isObject(value.urgent) &&
    isObject(value.model) &&
    Array.isArray(value.urgent.findings)
  );
}

/** One best-effort read of the project security reply: `null` on any error, 404 or timeout. */
export async function readSecurityStatusQuietly(
  client: PlatformClient,
  projectId: string,
  options: { timeoutMs?: number; cliLog?: CliLogger } = {},
): Promise<ProjectSecurityStatus | null> {
  const timeoutMs = options.timeoutMs ?? NOTICE_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      client.getProjectSecurity(projectId, { signal: abort.signal }),
      new Promise<never>((_, reject) => {
        hardStop = setTimeout(() => reject(new Error('timed out')), timeoutMs + 250);
      }),
    ]);
    if (!usable(status)) {
      options.cliLog?.debug('security_notice_skipped', { reason: 'unexpected_reply' });
      return null;
    }
    return status;
  } catch (error) {
    options.cliLog?.debug('security_notice_skipped', {
      reason: error instanceof PlatformApiError ? `http_${error.status}` : 'error',
    });
    return null;
  } finally {
    clearTimeout(timer);
    clearTimeout(hardStop);
  }
}

/** The `Security` line of `void project status`; `null` when audits are off or not for this project. */
export function formatProjectStatusSecurityLine(
  slug: string,
  status: ProjectSecurityStatus,
): string | null {
  if (status.policy.mode === 'disabled' || slug.startsWith('preview-')) {
    return null;
  }
  const { urgent, counts } = status;
  if (urgent.count <= 0) {
    return 'Security  no urgent findings open';
  }
  return `Security  ${urgent.count} urgent open · ${counts.leads} ${counts.leads === 1 ? 'lead' : 'leads'} → void project security list --urgent`;
}

/**
 * After a managed deploy is live, says what the security scan is doing and lists open urgent
 * findings (spec §6.5, §11.1). One read with a 5 s limit. Any error, a 404 from a platform without
 * security audits, or a timeout prints nothing, and the exit code is never touched.
 */
export async function printDeploySecurityNotice(input: DeploySecurityNoticeInput): Promise<void> {
  // A deploy whose routing was not published is still committed live, so it still gets the notice.
  if (input.slug.startsWith('preview-')) {
    return;
  }
  try {
    const status = await readSecurityStatusQuietly(input.client, input.projectId, {
      timeoutMs: input.timeoutMs,
      cliLog: input.cliLog,
    });
    if (!status) {
      return;
    }
    const lines = formatDeploySecurityNotice(
      {
        slug: input.slug,
        deploymentId: input.deploymentId,
        projectId: input.projectId,
        env: input.env,
      },
      status,
    );
    input.cliLog?.info('security_notice', {
      printed: lines.length > 0,
      urgent: status.urgent.count,
      scan: status.lastScan?.deploymentId === input.deploymentId ? status.lastScan.status : null,
    });
    if (lines.length === 0) {
      return;
    }
    const write = input.write ?? ((line: string) => console.log(line));
    write('');
    for (const line of lines) {
      write(line);
    }
  } catch (error) {
    // Formatting must never fail a deploy that is already live.
    input.cliLog?.debug('security_notice_skipped', {
      reason: error instanceof Error ? error.name : 'error',
    });
  }
}
