/** @jsxImportSource react */

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Table, TableBody, TableCell, TableRow } from '@astryxdesign/core/Table';
import { Heading } from '@astryxdesign/core/Text';
import { useState } from 'react';
import { useRequest, useView } from 'react-fate';
import { SecurityView, securityRequest } from '../../fate/views.ts';
import type { AdminPageProps } from '../page-utils.ts';
import { AdminCard } from './AdminCard.tsx';
import { formatDateTime } from './format.ts';
import { FormCheckbox, FormNumberInput, FormSelector } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { Pagination } from './Pagination.tsx';
import { bypassActor, scanStatusText, TableHead, usd } from './ProjectSecuritySection.tsx';
import { SectionStack } from './SectionStack.tsx';

const HOME = '/admin/security';
const UPGRADE = 'void platform upgrade --security-audits';

type Variant = 'neutral' | 'info' | 'success' | 'warning' | 'error';

interface VariantByValue {
  readonly [value: string]: Variant;
}
const SEVERITY_VARIANT: VariantByValue = { critical: 'error', high: 'warning' };
const SCAN_VARIANT: VariantByValue = {
  succeeded: 'success',
  running: 'info',
  queued: 'info',
  pending_input: 'info',
  failed: 'error',
  timed_out: 'error',
  refused: 'error',
};

function withQuery(path: string, changes: Readonly<Record<string, string | null>>): string {
  const url = new URL(path, 'https://admin.invalid');
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url.pathname + url.search;
}

function Tabs({
  section,
  urgentTotal,
  unseenBypasses,
}: {
  section: string;
  urgentTotal: number;
  unseenBypasses: number;
}) {
  const tab = (id: string, href: string, label: string) => (
    <Button
      key={id}
      href={href}
      label={label}
      size="sm"
      variant={section === id ? 'primary' : 'secondary'}
    />
  );
  return (
    <nav aria-label="Security sections" className="void-admin-security-tabs">
      {tab('settings', HOME, 'Settings')}
      {tab(
        'findings',
        `${HOME}/findings`,
        `Findings${urgentTotal ? ` · ${urgentTotal} urgent` : ''}`,
      )}
      {tab('scans', `${HOME}/scans`, 'Scans')}
      {tab(
        'requests',
        `${HOME}/requests`,
        `Public requests${unseenBypasses ? ` · ${unseenBypasses} new bypass${unseenBypasses === 1 ? '' : 'es'}` : ''}`,
      )}
    </nav>
  );
}

function FilterLinks({
  path,
  items,
}: {
  path: string;
  items: ReadonlyArray<
    Readonly<{ label: string; changes: Record<string, string | null>; on: boolean }>
  >;
}) {
  return (
    <div className="void-admin-security-tabs">
      {items.map((item) => (
        <Button
          key={item.label}
          href={withQuery(path, { ...item.changes, page: null })}
          label={item.label}
          size="sm"
          variant={item.on ? 'primary' : 'secondary'}
        />
      ))}
    </div>
  );
}

export function SecurityPage({ path, platformName, username }: AdminPageProps) {
  const data = useSecurityData(path);
  if (!data) {
    throw new Error('Security audits are unavailable.');
  }
  const { section, capability, tz } = data;
  return (
    <Layout platformName={platformName} title="Security" username={username}>
      <PageStack className="void-admin-security">
        <SectionStack as="header" className="void-admin-security-intro">
          <Heading level={1}>Security</Heading>
          <p>
            AI security reviews of what projects deploy. Findings never block a deploy. With the
            public gate on, they hold only a change from protected to public.
          </p>
        </SectionStack>
        <Tabs
          section={section}
          urgentTotal={data.urgentTotal}
          unseenBypasses={data.unseenBypasses}
        />
        {!capability && section !== 'settings' && (
          <Banner
            status="info"
            title="Security audits are not installed"
            description={`Old findings and records stay listed. Run: ${UPGRADE}`}
          />
        )}
        {section === 'settings' && data.settings && (
          <SettingsSection
            settings={data.settings}
            capability={capability}
            revision={data.revision}
          />
        )}
        {section === 'findings' && data.findings && data.findingFilter && (
          <FindingsSection
            path={path}
            findings={data.findings}
            filter={data.findingFilter}
            tz={tz}
          />
        )}
        {section === 'scans' && data.scans && (
          <ScansSection path={path} scans={data.scans} tz={tz} capability={capability} />
        )}
        {section === 'requests' && data.requests && (
          <RequestsSection
            path={path}
            requests={data.requests}
            unseen={data.unseenBypasses}
            emailEnabled={data.emailEnabled}
            tz={tz}
          />
        )}
        {section !== 'settings' && (
          <Pagination page={data.page} totalPages={data.totalPages} baseUrl={path} />
        )}
      </PageStack>
    </Layout>
  );
}

function useSecurityData(path: string) {
  const { security: ref } = useRequest(securityRequest(path), { mode: 'stale-while-revalidate' });
  return useView(SecurityView, ref);
}
type SecurityData = NonNullable<ReturnType<typeof useSecurityData>>;
type Settings = SecurityData['settings'];

function SettingsSection({
  settings,
  capability,
  revision,
}: {
  settings: NonNullable<Settings>;
  capability: boolean;
  revision: number;
}) {
  const [mode, setMode] = useState(settings.mode);
  const gateNeedsZeroTrust = settings.zeroTrustFact !== 'enabled' && !settings.publicGate;
  const probe = settings.entitlement;
  return (
    <>
      <AdminCard
        title="Status"
        headerAccessory={
          <Badge
            label={capability ? 'On' : 'Not installed'}
            variant={capability ? 'success' : 'neutral'}
          />
        }
      >
        {settings.unreadable && (
          <Banner
            status="error"
            title="The saved policy is unreadable"
            description="Scans treat it as off. Saving a policy below replaces it."
          />
        )}
        {capability && settings.lowConfirmation && (
          <Banner
            status="warning"
            title="Few findings are confirmed; most results are leads that need a human look."
            description="Scans read the code only. Check each lead before acting on it."
          />
        )}
        {!capability ? (
          <p>
            Capability: not installed. Run: <code>{UPGRADE}</code>
          </p>
        ) : (
          <>
            <p>
              Probe:{' '}
              {probe === null
                ? 'never run'
                : probe.ok
                  ? `all required checks passed (${probe.fresh ? 'fresh' : 'older than a day'})`
                  : `failed: ${probe.missing.join(', ')}`}
            </p>
            <form method="post" action={`${HOME}/probe`}>
              <Button type="submit" label="Check again" variant="secondary" size="sm" />
            </form>
          </>
        )}
      </AdminCard>

      {capability && (
        <AdminCard
          title="Policy"
          description={'"Public" means not protected by Zero Trust right now.'}
        >
          <SectionStack as="form" method="post" action={`${HOME}/policy`}>
            <input type="hidden" name="expectedRevision" value={revision} />
            <RadioList
              label="Scan"
              size="sm"
              htmlName="mode"
              value={mode}
              onChange={(value: string) => setMode(value as typeof mode)}
            >
              <RadioListItem value="disabled" label="Off" />
              <RadioListItem value="public" label="Public projects only" />
              <RadioListItem value="all" label="All projects" />
            </RadioList>
            {gateNeedsZeroTrust ? (
              <p>
                Public gate: turn on platform Zero Trust first (Zero Trust, then Configure). The
                gate needs it.
              </p>
            ) : (
              <>
                <FormCheckbox
                  label="Scan before a project goes public"
                  name="publicGate"
                  submitValue="yes"
                  initialValue={settings.publicGate}
                />
                <p>
                  Holds protected projects until a scan of the live deployment finds nothing urgent.
                  It never blocks deploys.
                </p>
              </>
            )}
            {settings.publicGate && settings.newProjectsStartPublic && (
              <Banner
                status="warning"
                title="New projects start public"
                description="Protect new projects by default is off in Zero Trust, so new projects are not covered by the gate."
              />
            )}
            <FormSelector
              label="Default model"
              name="defaultModel"
              initialValue={settings.defaultModel}
              width={420}
              options={settings.models.map((model) => ({
                value: model.id,
                label: `${model.id} (${model.badges.join(', ')})`,
              }))}
            />
            <fieldset className="void-admin-security-models">
              <legend>Models projects can pick (untick to block)</legend>
              {settings.models.map((model) => (
                <div key={model.id}>
                  <FormCheckbox
                    label={`${model.id} - ${model.badges.join(' · ')}${model.hostOk ? '' : ' - not ready (probe check 5: credits or scanner image)'}${model.priced ? '' : ' - no list price yet'}`}
                    name={`allow:${model.id}`}
                    submitValue="yes"
                    initialValue={!model.blocked}
                  />
                </div>
              ))}
            </fieldset>
            <FormCheckbox
              label="I understand a third-party default sends project code to that provider (provider notice)"
              name="acceptNotice"
              submitValue="yes"
              initialValue={settings.providerNotice.accepted}
            />
            <div className="void-admin-zero-trust-actions">
              <FormNumberInput
                label="Scans at once"
                name="concurrency"
                initialValue={settings.limits.concurrency}
                width={160}
                required
              />
              <FormNumberInput
                label="Timeout (minutes)"
                name="timeoutMinutes"
                initialValue={settings.limits.timeoutMinutes}
                width={160}
                required
              />
            </div>
            <input type="hidden" name="step" value="preview" />
            <Button type="submit" label="Preview change" />
          </SectionStack>
        </AdminCard>
      )}

      {capability && (
        <AdminCard
          title="Budgets"
          description={`Off by default. Spent this month: ${usd(settings.platformSpent)}. Projects can lower their own cap; raise one project's limit in its Security section.`}
        >
          <SectionStack as="form" method="post" action={`${HOME}/budget`}>
            <input type="hidden" name="expectedRevision" value={revision} />
            <FormCheckbox
              label="Platform cap on"
              name="platformCapOn"
              submitValue="yes"
              initialValue={settings.budgets.platformCapOn}
            />
            <FormNumberInput
              label="Platform cap (USD per month)"
              name="platformMonthlyUsd"
              initialValue={settings.budgets.platformMonthlyUsd}
              min={0}
              width={220}
            />
            <FormCheckbox
              label="Project caps on for every project"
              name="projectCapsOn"
              submitValue="yes"
              initialValue={settings.budgets.projectCapsOn}
            />
            <FormNumberInput
              label="Default project limit (USD per month)"
              name="projectDefaultMonthlyUsd"
              initialValue={settings.budgets.projectDefaultMonthlyUsd}
              min={0}
              width={220}
            />
            <input type="hidden" name="step" value="preview" />
            <Button type="submit" label="Preview change" />
          </SectionStack>
        </AdminCard>
      )}
    </>
  );
}

function FindingsSection({
  path,
  findings,
  filter,
  tz,
}: {
  path: string;
  findings: NonNullable<SecurityData['findings']>;
  filter: Readonly<{ state: string; urgent: boolean; severity: string | null }>;
  tz: string | undefined;
}) {
  return (
    <AdminCard title="Findings" description="Oldest first, so the ones waiting longest come first.">
      <FilterLinks
        path={path}
        items={[
          {
            label: 'Open',
            changes: { state: null, urgent: null },
            on: filter.state === 'open' && !filter.urgent,
          },
          {
            label: 'Urgent (critical and high)',
            changes: { state: null, urgent: '1' },
            on: filter.urgent,
          },
          {
            label: 'Resolved',
            changes: { state: 'resolved', urgent: null },
            on: filter.state === 'resolved',
          },
          {
            label: 'All',
            changes: { state: 'all', urgent: null },
            on: filter.state === 'all' && !filter.urgent,
          },
        ]}
      />
      {findings.findings.length === 0 ? (
        <p>No findings match.</p>
      ) : (
        <Table>
          <TableHead
            labels={['ID', 'Project', 'Severity', 'Title', 'File', 'First seen', 'State']}
          />
          <TableBody>
            {findings.findings.map((finding) => (
              <TableRow key={`${finding.projectId}:${finding.id}`}>
                <TableCell>{finding.id}</TableCell>
                <TableCell>
                  <a href={`/admin/projects/${finding.projectId}#security`}>{finding.project}</a>
                </TableCell>
                <TableCell>
                  <Badge
                    label={finding.severity ?? 'lead'}
                    variant={SEVERITY_VARIANT[finding.severity ?? ''] ?? 'neutral'}
                  />
                </TableCell>
                <TableCell>
                  {finding.title}
                  {finding.verdict === 'needs_validation' ? ' (lead)' : ''}
                </TableCell>
                <TableCell>
                  {finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '-'}
                </TableCell>
                <TableCell>
                  {finding.firstSeenAt ? formatDateTime(finding.firstSeenAt, tz) : '-'}
                </TableCell>
                <TableCell>
                  {finding.state}
                  {finding.resolution ? ` (${finding.resolution})` : ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </AdminCard>
  );
}

const CANCELABLE = new Set(['pending_input', 'queued', 'running']);

function ScansSection({
  path,
  scans,
  tz,
  capability,
}: {
  path: string;
  scans: NonNullable<SecurityData['scans']>;
  tz: string | undefined;
  capability: boolean;
}) {
  const { month, filter } = scans;
  return (
    <>
      {scans.installationFailureAlert && (
        <Banner
          status="warning"
          title="Scans are failing across the platform"
          description={`${Math.round(scans.installationFailureAlert.rate * 100)}% of the ${scans.installationFailureAlert.finished} scans that finished in the last 24 hours did not succeed.`}
        />
      )}
      {scans.silentGaps.length > 0 && (
        <Banner
          status="warning"
          title="Projects with a scan gap"
          description={`Three scans in a row did not succeed: ${scans.silentGaps.map((gap) => gap.slug).join(', ')}.`}
        />
      )}
      {scans.protectionChurn.length > 0 && (
        <Banner
          status="warning"
          title="Projects switching Zero Trust protection"
          description={`Protection changed 2 or more times in 7 days while urgent findings are open, so some deploys may not have been scanned: ${scans.protectionChurn.map((project) => `${project.slug} (${project.changes} changes)`).join(', ')}.`}
        />
      )}
      <AdminCard
        title="This month"
        description={`${month.scans} scans · ${usd(month.meteredUsd)} metered · ${usd(month.gatewayUsd)} from gateway · ${month.refused} refused · ${month.failed} failed · ${month.skippedBudget} skipped (budget)`}
      >
        {scans.topSpenders.length > 0 && (
          <>
            <h3>Top projects by spend</h3>
            <ol>
              {scans.topSpenders.map((spender) => (
                <li key={spender.projectId}>
                  <a href={`/admin/projects/${spender.projectId}#security`}>{spender.slug}</a>
                  {': '}
                  {usd(spender.spentUsd)} ({spender.scans} scans)
                </li>
              ))}
            </ol>
          </>
        )}
      </AdminCard>
      <AdminCard title="Scans">
        <FilterLinks
          path={path}
          items={[
            {
              label: 'All',
              changes: { status: null, trigger: null },
              on: !filter.status && !filter.gate,
            },
            ...[
              ['failed', 'Failed'],
              ['refused', 'Refused'],
              ['running', 'Running'],
              ['skipped', 'Skipped'],
            ].map(([status = '', label = '']) => ({
              label,
              changes: { status, trigger: null },
              on: filter.status === status,
            })),
            { label: 'Gate scans', changes: { status: null, trigger: 'gate' }, on: filter.gate },
          ]}
        />
        {scans.scans.length === 0 ? (
          <p>No scans match.</p>
        ) : (
          <Table>
            <TableHead
              labels={[
                'Status',
                'Project',
                'Coverage',
                'Model',
                'Metered',
                'Gateway',
                'Started',
                'Actions',
              ]}
            />
            <TableBody>
              {scans.scans.map((scan) => (
                <TableRow key={scan.id}>
                  <TableCell>
                    <Badge label={scan.status} variant={SCAN_VARIANT[scan.status] ?? 'neutral'} />
                    {scanStatusText(scan)}
                    {scan.trigger === 'gate' ? ' gate' : ''}
                  </TableCell>
                  <TableCell>
                    <a href={`/admin/projects/${scan.projectId}#security`}>{scan.project}</a>
                  </TableCell>
                  <TableCell>{scan.coverageLabel ?? scan.tier ?? '-'}</TableCell>
                  <TableCell>{scan.model ?? '-'}</TableCell>
                  <TableCell>{usd(scan.meteredUsd)}</TableCell>
                  <TableCell>{usd(scan.gatewayUsd)}</TableCell>
                  <TableCell>{formatDateTime(scan.startedAt ?? scan.createdAt, tz)}</TableCell>
                  <TableCell>
                    {capability && CANCELABLE.has(scan.status) && (
                      <form
                        method="post"
                        action={`${HOME}/scans/${scan.id}/cancel`}
                        data-confirm="Cancel this scan?"
                      >
                        <Button type="submit" label="Cancel" variant="secondary" size="sm" />
                      </form>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AdminCard>
    </>
  );
}

function RequestsSection({
  path,
  requests,
  unseen,
  emailEnabled,
  tz,
}: {
  path: string;
  requests: NonNullable<SecurityData['requests']>;
  unseen: number;
  emailEnabled: boolean;
  tz: string | undefined;
}) {
  return (
    <>
      {!emailEnabled && (
        <Banner
          status="info"
          title="Email is off"
          description="Installation admins see bypasses only here."
        />
      )}
      <AdminCard title="Public requests" description="Projects waiting to go public.">
        <FilterLinks
          path={path}
          items={[
            ['open', 'Open'],
            ['bypassed', 'Bypassed'],
            ['closed', 'Closed'],
            ['all', 'All'],
          ].map(([state = '', label = '']) => ({
            label,
            changes: { state: state === 'open' ? null : state },
            on: requests.state === state,
          }))}
        />
        {requests.requests.length === 0 ? (
          <p>No requests match.</p>
        ) : (
          <Table>
            <TableHead
              labels={[
                'Project',
                'State',
                'Held reason',
                'Asked via',
                'Asked at',
                'Gate scan',
                'Blockers',
              ]}
            />
            <TableBody>
              {requests.requests.map((request) => (
                <TableRow key={request.id}>
                  <TableCell>
                    <a href={`/admin/projects/${request.projectId}#zero-trust`}>
                      {request.project}
                    </a>
                  </TableCell>
                  <TableCell>
                    {request.state}
                    {requests.staleIds.includes(request.id) ? ' (held over 7 days)' : ''}
                  </TableCell>
                  <TableCell>{request.heldReason?.split('_').join(' ') ?? '-'}</TableCell>
                  <TableCell>{request.requestedVia}</TableCell>
                  <TableCell>
                    {request.requestedAt ? formatDateTime(request.requestedAt, tz) : '-'}
                  </TableCell>
                  <TableCell>{request.gateScanId ?? '-'}</TableCell>
                  <TableCell>
                    {request.blockers.count > 0
                      ? `${request.blockers.count} (${request.blockers.ids.join(', ')})`
                      : '0'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AdminCard>
      <AdminCard
        title="Bypasses"
        description="Every bypass of the public gate scan, newest first."
        headerAccessory={
          unseen > 0 ? <Badge label={`${unseen} new`} variant="warning" /> : undefined
        }
      >
        {unseen > 0 && (
          <form method="post" action={`${HOME}/bypasses/seen`}>
            <input type="hidden" name="through" value={requests.bypasses[0]?.createdAt ?? ''} />
            <Button type="submit" label="Mark all as seen" variant="secondary" size="sm" />
          </form>
        )}
        {requests.bypasses.length === 0 ? (
          <p>No bypasses.</p>
        ) : (
          <Table>
            <TableHead
              labels={['Project', 'Who', 'When', 'Reason', 'Request then', 'Deployment']}
            />
            <TableBody>
              {requests.bypasses.map((bypass) => (
                <TableRow key={bypass.id}>
                  <TableCell>
                    <a href={`/admin/projects/${bypass.projectId}#zero-trust`}>{bypass.project}</a>
                    {bypass.unseen ? ' ' : ''}
                    {bypass.unseen && <Badge label="new" variant="warning" />}
                  </TableCell>
                  <TableCell>
                    {bypassActor(bypass)} ({bypass.actorUserId})
                  </TableCell>
                  <TableCell>
                    {bypass.createdAt ? formatDateTime(bypass.createdAt, tz) : '-'}
                  </TableCell>
                  <TableCell>{bypass.reason}</TableCell>
                  <TableCell>
                    {bypass.requestState}
                    {bypass.blockers.count > 0 ? `, ${bypass.blockers.count} blockers` : ''}
                  </TableCell>
                  <TableCell>{bypass.deploymentId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AdminCard>
    </>
  );
}

export function SecurityPreviewPage({
  platformName,
  username,
  title,
  lines,
  action,
  fields,
  back,
}: {
  platformName: string;
  username?: string;
  title: string;
  lines: ReadonlyArray<string>;
  action: string;
  fields: ReadonlyArray<readonly [string, string]>;
  back: string;
}) {
  return (
    <Layout platformName={platformName} title="Security" username={username}>
      <PageStack className="void-admin-security">
        <AdminCard title={title}>
          {lines.length === 0 ? (
            <p>Nothing would change.</p>
          ) : (
            <ul>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <SectionStack as="form" method="post" action={action}>
            {fields.map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <input type="hidden" name="step" value="apply" />
            <div className="void-admin-zero-trust-actions">
              <Button type="submit" label="Apply change" />
              <Button href={back} label="Back" variant="secondary" />
            </div>
          </SectionStack>
        </AdminCard>
      </PageStack>
    </Layout>
  );
}
