/** @jsxImportSource react */

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import type { ReactNode } from 'react';
import type { loadProjectSecurity } from '../../security-data.ts';
import { formatDateTime } from './format.ts';
import { FormCheckbox, FormSelector, FormTextInput } from './FormControls.tsx';
import { SectionStack } from './SectionStack.tsx';

type ProjectSecurity = NonNullable<Awaited<ReturnType<typeof loadProjectSecurity>>>;
type Gate = Readonly<{ request: Readonly<{ state: string }> | null; copy: string | null }>;

export function usd(value: number | null | undefined, none = '-'): string {
  return value === null || value === undefined ? none : `$${value.toFixed(2)}`;
}

export function TableHead({ labels }: { labels: ReadonlyArray<string> }) {
  return (
    <TableHeader>
      <TableRow>
        {labels.map((label) => (
          <TableHeaderCell key={label}>{label}</TableHeaderCell>
        ))}
      </TableRow>
    </TableHeader>
  );
}

export function scanStatusText(
  scan: Readonly<{ statusReason: string | null; failureCause: string | null }>,
): string {
  return `${scan.statusReason ? ` ${scan.statusReason.split('_').join(' ')}` : ''}${scan.failureCause ? ` (${scan.failureCause})` : ''}`;
}

export function bypassActor(bypass: Readonly<{ actorKind: string; actorRole: string | null }>) {
  return bypass.actorKind === 'installation_admin'
    ? 'installation admin'
    : (bypass.actorRole ?? 'member');
}

/** Where the per-project limit comes from (M27). */
const CEILING_SOURCES: Readonly<Record<'project' | 'plan' | 'default', string>> = {
  project: 'set for this project',
  plan: "this owner's plan",
  default: 'default for every project',
};

function ProjectForm({
  projectId,
  path,
  children,
}: {
  projectId: string;
  path: string;
  children: ReactNode;
}) {
  return (
    <SectionStack
      as="form"
      method="post"
      action={`/admin/projects/${projectId}/security/${path}`}
      className="void-admin-security-form"
    >
      {children}
    </SectionStack>
  );
}

export function ProjectSecuritySection({
  projectId,
  security,
  gate,
  tz,
}: {
  projectId: string;
  security: ProjectSecurity;
  gate: Gate;
  tz: string | undefined;
}) {
  const { urgent, model, budget } = security;
  const notices = security.models.filter((entry) => entry.notice);
  return (
    <SectionStack id="security" className="void-admin-project-security">
      <h2>Security</h2>
      <div className="void-admin-project-zero-trust-state">
        <span>Scans apply: {security.policy.applies ? 'yes' : 'no'}</span>
        <span>{security.policy.reason}</span>
        <Badge
          label={urgent.count > 0 ? `${urgent.count} urgent` : 'no urgent findings'}
          variant={urgent.count > 0 ? 'error' : 'success'}
        />
      </div>
      <p>
        Urgent: {urgent.count}
        {urgent.ids.length > 0 ? ` (${urgent.ids.join(', ')})` : ''}
        {urgent.oldestFirstSeenAt ? `, oldest ${formatDateTime(urgent.oldestFirstSeenAt, tz)}` : ''}
        . Leads: {security.counts.leads}. Resolved: {security.counts.resolved}.
        {security.backlogFiles > 0 ? ` Unscanned backlog: ${security.backlogFiles} files.` : ''}
      </p>
      {gate.request && <p>Public request: {gate.copy ?? gate.request.state}</p>}

      <ProjectForm projectId={projectId} path="policy">
        <FormSelector
          label="Scan rule for this project"
          name="override"
          initialValue={security.policy.override}
          width={420}
          options={[
            { value: 'inherit', label: 'Follow the platform scan mode' },
            { value: 'always', label: 'Always scan, also while Zero Trust protects it' },
            { value: 'never', label: 'Never scan (a scan before it goes public still runs)' },
          ]}
        />
        <Button type="submit" label="Set scan rule" variant="secondary" />
      </ProjectForm>

      <ProjectForm projectId={projectId} path="model">
        <p>
          Model: {model.id ?? 'none available'}
          {model.source ? ` (${model.source})` : ''}
        </p>
        <FormSelector
          label="Model"
          name="model"
          initialValue={model.source === 'project' ? model.requested : ''}
          width={420}
          options={[
            { value: '', label: 'Platform default' },
            ...security.models
              .filter((entry) => entry.pickable)
              .map((entry) => ({
                value: entry.id,
                label: `${entry.id} (${entry.badges.join(', ')})`,
              })),
          ]}
        />
        {notices.length > 0 && (
          <details>
            <summary>Provider notice for third-party models</summary>
            {notices.map((entry) => (
              <div key={entry.id}>
                <strong>{entry.id}</strong>
                <ul>
                  {entry.notice?.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
          </details>
        )}
        <FormCheckbox
          label="I understand the provider notice"
          name="acceptNotice"
          submitValue="yes"
          initialValue={model.noticeAccepted}
        />
        <Button type="submit" label="Set model" variant="secondary" />
      </ProjectForm>

      {budget && (
        <ProjectForm projectId={projectId} path="budget">
          <p>
            Cap now: {usd(budget.capUsd, 'none')} ({budget.capSource}). Limit projects may not
            exceed: {usd(budget.ceilingUsd, 'none')}
            {budget.ceilingSource ? ` (${CEILING_SOURCES[budget.ceilingSource]})` : ''}. Spent this
            month: {usd(budget.spentUsd, 'none')}.
          </p>
          <FormTextInput
            label="Limit for this project (USD per month, empty to clear)"
            name="monthlyUsd"
            placeholder="50"
            width={320}
          />
          <Button type="submit" label="Set limit" variant="secondary" />
        </ProjectForm>
      )}

      <h3>Last scans</h3>
      {security.scans.length === 0 ? (
        <p>No scans yet.</p>
      ) : (
        <Table>
          <TableHead labels={['Status', 'Coverage', 'Model', 'Metered', 'When']} />
          <TableBody>
            {security.scans.map((scan) => (
              <TableRow key={scan.id}>
                <TableCell>
                  {scan.status}
                  {scanStatusText(scan)}
                </TableCell>
                <TableCell>{scan.coverageLabel ?? '-'}</TableCell>
                <TableCell>{scan.model ?? '-'}</TableCell>
                <TableCell>{usd(scan.meteredUsd)}</TableCell>
                <TableCell>{formatDateTime(scan.createdAt, tz)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <form
        method="post"
        action={`/admin/projects/${projectId}/security/rescan`}
        data-confirm="Run a full security scan of the live deployment? It uses the scan budget."
      >
        <Button type="submit" label="Rescan" variant="secondary" size="sm" />
      </form>

      <h3>Bypass history</h3>
      {security.bypasses.length === 0 ? (
        <p>No bypasses.</p>
      ) : (
        <Table>
          <TableHead labels={['Who', 'When', 'Reason', 'Request then', 'Deployment']} />
          <TableBody>
            {security.bypasses.map((bypass) => (
              <TableRow key={bypass.id}>
                <TableCell>{bypassActor(bypass)}</TableCell>
                <TableCell>
                  {bypass.createdAt ? formatDateTime(bypass.createdAt, tz) : '-'}
                </TableCell>
                <TableCell>{bypass.reason}</TableCell>
                <TableCell>{bypass.requestState}</TableCell>
                <TableCell>{bypass.deploymentId}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionStack>
  );
}
