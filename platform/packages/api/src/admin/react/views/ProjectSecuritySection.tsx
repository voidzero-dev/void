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
import { formatDateTime } from './format.ts';
import { FormCheckbox, FormSelector, FormTextInput } from './FormControls.tsx';
import { SectionStack } from './SectionStack.tsx';

type ProjectSecurity = Readonly<{
  policy: Readonly<{ applies: boolean; reason: string; publicGate: boolean }>;
  urgent: Readonly<{ count: number; oldestFirstSeenAt: string | null; ids: ReadonlyArray<string> }>;
  counts: Readonly<{ urgent: number; leads: number; resolved: number }>;
  model: Readonly<{
    id: string | null;
    requested: string;
    source: string | null;
    thirdParty: boolean;
    noticeAccepted: boolean;
  }>;
  models: ReadonlyArray<
    Readonly<{
      id: string;
      badges: ReadonlyArray<string>;
      pickable: boolean;
      thirdParty: boolean;
      notice: ReadonlyArray<string> | null;
    }>
  >;
  budget: Readonly<{
    capUsd: number | null;
    capSource: string;
    ceilingUsd: number | null;
    spentUsd: number;
  }> | null;
  backlogFiles: number;
  scans: ReadonlyArray<
    Readonly<{
      id: string;
      status: string;
      statusReason: string | null;
      failureCause: string | null;
      coverageLabel: string | null;
      model: string | null;
      meteredUsd: number | null;
      createdAt: string;
    }>
  >;
  bypasses: ReadonlyArray<
    Readonly<{
      id: string;
      actorKind: string;
      actorRole: string | null;
      reason: string;
      requestState: string;
      createdAt: string | null;
      deploymentId: string;
    }>
  >;
}>;

type Gate = Readonly<{ request: Readonly<{ state: string }> | null; copy: string | null }>;

function usd(value: number | null): string {
  return value === null ? 'none' : `$${value.toFixed(2)}`;
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

      <SectionStack
        as="form"
        method="post"
        action={`/admin/projects/${projectId}/security/model`}
        className="void-admin-security-form"
      >
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
      </SectionStack>

      {budget && (
        <SectionStack
          as="form"
          method="post"
          action={`/admin/projects/${projectId}/security/budget`}
          className="void-admin-security-form"
        >
          <p>
            Cap now: {usd(budget.capUsd)} ({budget.capSource}). Limit projects may not exceed:{' '}
            {usd(budget.ceilingUsd)}. Spent this month: {usd(budget.spentUsd)}.
          </p>
          <FormTextInput
            label="Limit for this project (USD per month, empty to clear)"
            name="monthlyUsd"
            placeholder="50"
            width={320}
          />
          <Button type="submit" label="Set limit" variant="secondary" />
        </SectionStack>
      )}

      <h3>Last scans</h3>
      {security.scans.length === 0 ? (
        <p>No scans yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Coverage</TableHeaderCell>
              <TableHeaderCell>Model</TableHeaderCell>
              <TableHeaderCell>Metered</TableHeaderCell>
              <TableHeaderCell>When</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {security.scans.map((scan) => (
              <TableRow key={scan.id}>
                <TableCell>
                  {scan.status}
                  {scan.statusReason ? ` ${scan.statusReason.split('_').join(' ')}` : ''}
                  {scan.failureCause ? ` (${scan.failureCause})` : ''}
                </TableCell>
                <TableCell>{scan.coverageLabel ?? '-'}</TableCell>
                <TableCell>{scan.model ?? '-'}</TableCell>
                <TableCell>
                  {scan.meteredUsd === null ? '-' : `$${scan.meteredUsd.toFixed(2)}`}
                </TableCell>
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
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Who</TableHeaderCell>
              <TableHeaderCell>When</TableHeaderCell>
              <TableHeaderCell>Reason</TableHeaderCell>
              <TableHeaderCell>Request then</TableHeaderCell>
              <TableHeaderCell>Deployment</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {security.bypasses.map((bypass) => (
              <TableRow key={bypass.id}>
                <TableCell>
                  {bypass.actorKind === 'installation_admin'
                    ? 'installation admin'
                    : (bypass.actorRole ?? 'member')}
                </TableCell>
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
