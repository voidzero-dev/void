import type { ReactNode } from 'react';
import type { Finding, Props, Scan } from './security.server.ts';

export const layout = 'dashboard';

type Role = NonNullable<Props['project']>['role'];

const canSettings = (role: Role) => role === 'owner' || role === 'admin';
const canComment = (role: Role) => role !== 'reader';

/** Finding fields arrive as JSON values; the page shows them as plain text only. */
function text(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(text).join('\n');
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function usd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function day(iso: string | null): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time)
    ? 'unknown date'
    : new Date(time).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
}

interface RequestStateCopy {
  readonly [state: string]: string;
}
const REQUEST_STATES: RequestStateCopy = {
  waiting_scan: 'waiting for a security scan of the live deployment',
  held_findings: 'held: urgent findings must be resolved first',
  held_no_result: 'held: the security scan did not finish',
  needs_deploy: 'held: deploy again so the live deployment can be scanned',
};

function Notice({ notice }: { notice: Props['notice'] }) {
  if (!notice) {
    return null;
  }
  return (
    <p className={`security-notice security-notice--${notice.kind}`} role="status">
      {notice.text}
    </p>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="security-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: unknown }) {
  const body = text(value);
  return body ? (
    <>
      <strong>{label}</strong>
      <pre className="security-pre">{body}</pre>
    </>
  ) : null;
}

function HiddenProject({ id }: { id: string }) {
  return <input type="hidden" name="projectId" value={id} />;
}

function FindingForms({
  finding,
  projectId,
  role,
}: {
  finding: Finding;
  projectId: string;
  role: Role;
}) {
  const id = text(finding.id);
  return (
    <>
      {canSettings(role) && finding.state === 'open' && typeof finding.revision === 'number' && (
        <form className="security-form" method="post" action="?resolve">
          <HiddenProject id={projectId} />
          <input type="hidden" name="finding" value={id} />
          <input type="hidden" name="expectedRevision" value={finding.revision} />
          <label>
            Resolve as
            <select name="reason" defaultValue="fixed">
              <option value="fixed">Fixed</option>
              <option value="false_positive">False positive</option>
              <option value="accepted_risk">Accepted risk</option>
            </select>
          </label>
          <label>
            Why (shown in the history)
            <textarea name="comment" required maxLength={4000} />
          </label>
          <button type="submit">Resolve {id}</button>
        </form>
      )}
      {canComment(role) && (
        <form className="security-form" method="post" action="?comment">
          <HiddenProject id={projectId} />
          <input type="hidden" name="finding" value={id} />
          <label>
            Comment
            <textarea name="text" required maxLength={4000} />
          </label>
          <button type="submit">Add comment</button>
        </form>
      )}
    </>
  );
}

function FindingRow({
  finding,
  projectId,
  role,
}: {
  finding: Finding;
  projectId: string;
  role: Role;
}) {
  const id = text(finding.id);
  const severity = text(finding.severity) || 'lead';
  if (role === 'reader') {
    // Readers get ids and severities of open findings, titles of resolved ones.
    return (
      <li>
        <span className="security-severity">{severity}</span> {id}{' '}
        {finding.state === 'resolved' ? text(finding.title) : ''}
      </li>
    );
  }
  const where = finding.file
    ? `${text(finding.file)}${finding.line ? `:${text(finding.line)}` : ''}`
    : '';
  return (
    <li>
      <details>
        <summary>
          <span className="security-severity">{severity}</span> {id} {text(finding.title)}{' '}
          {where && <code>{where}</code>}
        </summary>
        <div className="security-detail">
          <p>
            {[finding.category, finding.cwe, finding.confidence]
              .flatMap((value) => {
                const shown = text(value);
                return shown ? [shown] : [];
              })
              .join(' · ')}
          </p>
          <Detail label="Trace" value={finding.trace} />
          <Detail label="Evidence" value={finding.evidence} />
          <Detail label="Conditions" value={finding.conditions} />
          <Detail label="Suggested fix" value={finding.fix} />
          {finding.state === 'resolved' && <p>Resolved as {text(finding.resolution)}.</p>}
          <FindingForms finding={finding} projectId={projectId} role={role} />
        </div>
      </details>
    </li>
  );
}

function FindingList({
  title,
  findings,
  projectId,
  role,
}: {
  title: string;
  findings: ReadonlyArray<Finding>;
  projectId: string;
  role: Role;
}) {
  if (findings.length === 0) {
    return null;
  }
  return (
    <section className="security-section">
      <h2>{title}</h2>
      <ul className="security-list">
        {findings.map((finding) => (
          <FindingRow key={text(finding.id)} finding={finding} projectId={projectId} role={role} />
        ))}
      </ul>
    </section>
  );
}

function ModelForm({
  status,
  projectId,
}: {
  status: NonNullable<Props['status']>;
  projectId: string;
}) {
  const { defaultModel, saved, defaultNotice, noticeVersion, choices } = status.modelChoices;
  // The saved choice, not the model in use: `''` only when the project follows the default.
  const picked = saved ?? '';
  const notices = new Map<string, ReadonlyArray<string>>();
  for (const choice of choices) {
    if (choice.notice) {
      notices.set(choice.provider, choice.notice);
    }
  }
  // A third-party default waiting for the notice: show its text, so the box never asks
  // to accept a notice the page did not show.
  if (status.model.pendingDefault !== null && defaultNotice) {
    notices.set(defaultNotice.provider, defaultNotice.notice);
  }
  return (
    <form className="security-form" method="post" action="?model">
      <HiddenProject id={projectId} />
      <label>
        Scan model
        <select name="model" defaultValue={picked}>
          <option value="">Platform default ({defaultModel})</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.id} · {choice.badges.join(' · ')}
            </option>
          ))}
          {picked && !choices.some((choice) => choice.id === picked) && (
            <option value={picked}>{picked} (cannot be picked now)</option>
          )}
        </select>
      </label>
      {notices.size > 0 && (
        <>
          {[...notices].map(([provider, lines]) => (
            <details key={provider}>
              <summary>Provider notice: {provider}</summary>
              {lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </details>
          ))}
          <label className="security-check">
            <input type="checkbox" name="acceptProviderNotice" value="1" />I have read the provider
            notice. Code from this project may be sent to that provider.
          </label>
          <input type="hidden" name="noticeVersion" value={noticeVersion} />
        </>
      )}
      <button type="submit">Save model</button>
    </form>
  );
}

function BudgetForm({
  status,
  projectId,
}: {
  status: NonNullable<Props['status']>;
  projectId: string;
}) {
  const { budget } = status;
  if (!budget) {
    return null;
  }
  return (
    <form className="security-form" method="post" action="?budget">
      <HiddenProject id={projectId} />
      <label>
        Monthly scan budget for this project (USD)
        <input name="usd" inputMode="decimal" autoComplete="off" placeholder="100" />
      </label>
      <p className="dashboard-description">
        Leave it empty to remove this project’s own cap.
        {budget.ceilingUsd === null ? '' : ` The most you can set is ${usd(budget.ceilingUsd)}.`}
      </p>
      <button type="submit">Save budget</button>
    </form>
  );
}

function BypassForm({ projectId }: { projectId: string }) {
  return (
    <form className="security-form" method="post" action="?bypass">
      <HiddenProject id={projectId} />
      <label>
        Why skip the scan
        <textarea name="reason" required maxLength={4000} />
      </label>
      <label className="security-check">
        <input type="checkbox" name="confirm" value="1" required />
        Make the project public without a passing security scan. The bypass and its reason are
        recorded, and platform admins get an email.
      </label>
      <button type="submit">Bypass the scan</button>
    </form>
  );
}

function ScanList({ scans }: { scans: ReadonlyArray<Scan> }) {
  if (scans.length === 0) {
    return null;
  }
  return (
    <section className="security-section">
      <h2>Scans</h2>
      <ul className="security-list">
        {scans.map((scan) => (
          <li key={scan.id}>
            {[
              day(scan.createdAt),
              scan.status,
              scan.trigger,
              scan.deploymentId ?? '',
              scan.model ?? '',
              scan.meteredUsd === null ? '' : usd(scan.meteredUsd),
            ]
              .filter(Boolean)
              .join(' · ')}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ProjectSecurityPage({
  slug,
  project,
  status,
  open,
  resolved,
  scans,
  notice,
}: Props) {
  return (
    <main className="dashboard-main">
      <section className="wrapper wrapper--ticks dashboard-page security-page">
        <p>
          <a href="/projects">Projects</a>
        </p>
        <h1 className="dashboard-heading">{slug} · Security</h1>
        <Notice notice={notice} />
        {!project || !status ? (
          !notice && <p>This project does not exist, or you are not a member of it.</p>
        ) : status.policy.mode === 'disabled' ? (
          <p>{status.policy.reason}</p>
        ) : (
          <Body project={project} status={status} open={open} resolved={resolved} scans={scans} />
        )}
        <p className="dashboard-description">
          AI review can be wrong. “No findings” does not mean “no bugs”. Security findings never
          block deploys.
        </p>
      </section>
    </main>
  );
}

function Body({
  project,
  status,
  open,
  resolved,
  scans,
}: {
  project: NonNullable<Props['project']>;
  status: NonNullable<Props['status']>;
  open: Props['open'];
  resolved: Props['resolved'];
  scans: Props['scans'];
}) {
  const { role, id } = project;
  const urgent = open.filter((finding) => finding.urgent === true);
  const leads = open.filter((finding) => finding.verdict === 'needs_validation');
  const other = open.filter(
    (finding) => finding.urgent !== true && finding.verdict !== 'needs_validation',
  );
  const request = status.publicRequest;
  const bypassOffered =
    canSettings(role) &&
    status.urgent.count === 0 &&
    (request?.state === 'waiting_scan' ||
      request?.state === 'held_no_result' ||
      request?.state === 'needs_deploy');
  const last = status.lastSuccessfulScan ?? status.lastScan;
  return (
    <>
      {status.urgent.count > 0 && (
        <p className="security-notice security-notice--error">
          <strong>
            {status.urgent.count} urgent {status.urgent.count === 1 ? 'finding is' : 'findings are'}{' '}
            open
          </strong>{' '}
          ({status.urgent.counts.critical} critical, {status.urgent.counts.high} high). Fix the
          code, then a project admin or owner resolves them.
        </p>
      )}
      <dl className="security-summary">
        <Field label="Last scan">
          {last
            ? [last.status, last.deploymentId, last.coverageLabel].filter(Boolean).join(' · ')
            : 'No scan yet. The first scan runs after your next deploy and reviews the whole app.'}
        </Field>
        <Field label="Policy">
          {status.policy.applies ? 'applies' : 'does not apply'}: {status.policy.reason}
        </Field>
        {status.model.id && <Field label="Model">{status.model.id}</Field>}
        {status.budget && (
          <Field label="Budget">
            {usd(status.budget.spentUsd)}
            {status.budget.capUsd === null ? '' : ` of ${usd(status.budget.capUsd)}`} this month ·
            resets {day(status.budget.resetsAt)}
          </Field>
        )}
        {request && (
          <Field label="Public">
            {REQUEST_STATES[request.state] ?? request.state}
            {request.blockers.ids.length > 0 ? ` (${request.blockers.ids.join(', ')})` : ''}
          </Field>
        )}
      </dl>
      {role === 'reader' ? (
        <section className="security-section">
          <h2>Open findings</h2>
          <p>
            Urgent {status.urgent.count} · critical {status.counts.open.critical} · high{' '}
            {status.counts.open.high} · medium {status.counts.open.medium} · low{' '}
            {status.counts.open.low} · leads {status.counts.leads}
          </p>
          {open.length > 0 && <p>{open.map((finding) => text(finding.id)).join(', ')}</p>}
        </section>
      ) : (
        <>
          <FindingList
            title="Urgent (confirmed critical or high)"
            findings={urgent}
            projectId={id}
            role={role}
          />
          <FindingList title="Other open" findings={other} projectId={id} role={role} />
          <FindingList
            title="Leads (need a human look)"
            findings={leads}
            projectId={id}
            role={role}
          />
        </>
      )}
      <FindingList title="Resolved" findings={resolved} projectId={id} role={role} />
      {scans && <ScanList scans={scans} />}
      {canSettings(role) && (
        <section className="security-section">
          <h2>Settings</h2>
          <ModelForm status={status} projectId={id} />
          <BudgetForm status={status} projectId={id} />
        </section>
      )}
      {bypassOffered && (
        <section className="security-section">
          <h2>Public request</h2>
          <BypassForm projectId={id} />
        </section>
      )}
      {role !== 'reader' && !canSettings(role) && (
        <p>A project admin or owner can resolve these.</p>
      )}
    </>
  );
}
