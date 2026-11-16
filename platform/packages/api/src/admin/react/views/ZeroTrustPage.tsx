/** @jsxImportSource react */

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Heading } from '@astryxdesign/core/Text';
import { useState } from 'react';
import { useRequest, useView } from 'react-fate';
import { ZeroTrustView, zeroTrustRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { AdminCard } from './AdminCard.tsx';
import { FormCheckbox, FormTextInput } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { SectionStack } from './SectionStack.tsx';

const HOME = '/admin/zero-trust';

type StatusBadge = Readonly<{
  label: string;
  variant: 'neutral' | 'info' | 'success' | 'warning' | 'error';
}>;

function statusBadge(configured: boolean, enabled: boolean, status: string | null): StatusBadge {
  if (!configured) {
    return { label: 'Not configured', variant: 'neutral' };
  }
  if (status === 'invalid_configuration') {
    return { label: 'Invalid configuration', variant: 'error' };
  }
  if (status === 'error') {
    return { label: 'Needs attention', variant: 'error' };
  }
  if (status === 'configuring') {
    return { label: 'Configuring', variant: 'info' };
  }
  if (status === 'disabling') {
    return { label: 'Disabling', variant: 'warning' };
  }
  return enabled
    ? { label: 'Enabled', variant: 'success' }
    : { label: 'Disabled', variant: 'neutral' };
}

function liveLabel(
  enabled: boolean,
  checked: boolean,
  live: Readonly<{ present: boolean; drifted: boolean }> | null,
): string {
  if (!enabled) {
    return 'Not active';
  }
  if (!checked || !live) {
    return 'Not checked';
  }
  return live.present && !live.drifted ? 'Healthy' : 'Missing or drifted';
}

export function ZeroTrustPage({ path, platformName, username }: AdminPageProps) {
  const { zeroTrust: ref } = useRequest(zeroTrustRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(ZeroTrustView, ref);
  if (!pageData) {
    throw new Error('Zero Trust settings are unavailable.');
  }
  const {
    configured,
    enabled,
    status,
    accountId,
    teamDomain,
    identityProviderIds,
    policyIds,
    protectNewProjects,
    operation,
    lastError,
    checked,
    live,
    projects,
  } = pageData;
  // The existing-project choice applies only when enabling, or when a
  // replacement token resumes an enabling operation.
  const choosesExistingProjects = operation ? operation.existingProjects !== null : !enabled;
  const [existingProjects, setExistingProjects] = useState<'protected' | 'public'>(
    operation?.existingProjects === 'public' ? 'public' : 'protected',
  );
  const badge = statusBadge(configured, enabled, status ?? null);
  const publicOnly =
    configured &&
    status !== 'invalid_configuration' &&
    identityProviderIds.length === 0 &&
    policyIds.length === 0;
  return (
    <Layout platformName={platformName} title="Zero Trust" username={username}>
      <PageStack className="void-admin-zero-trust">
        <SectionStack as="header" className="void-admin-zero-trust-intro">
          <Heading level={1}>Project Zero Trust</Heading>
          <p>
            Void manages a wildcard Cloudflare Access application for protected projects and
            exact-host bypass applications for public exceptions. The Cloudflare API token is
            encrypted and never shown again.
          </p>
        </SectionStack>

        {lastError && (
          <Banner role="alert" status="error" title="Last error" description={lastError} />
        )}

        <section aria-labelledby="zero-trust-status-heading">
          <AdminCard
            title="Status"
            titleId="zero-trust-status-heading"
            headerAccessory={<Badge label={badge.label} variant={badge.variant} />}
          >
            <dl className="void-admin-zero-trust-details">
              <div>
                <dt>Current operation</dt>
                <dd>{operation ? `${operation.kind} · ${operation.phase}` : 'None'}</dd>
              </div>
              <div>
                <dt>Cloudflare account</dt>
                <dd>{accountId ?? '—'}</dd>
              </div>
              <div>
                <dt>Access team domain</dt>
                <dd>{teamDomain ?? '—'}</dd>
              </div>
              <div>
                <dt>Protect new projects</dt>
                <dd>{protectNewProjects === null ? '—' : protectNewProjects ? 'Yes' : 'No'}</dd>
              </div>
              <div>
                <dt>Live application</dt>
                <dd>{liveLabel(enabled, checked, live)}</dd>
              </div>
            </dl>
            {enabled && !checked && (
              <Button
                href={`${HOME}?check=1`}
                label="Check with Cloudflare"
                variant="secondary"
                size="sm"
              />
            )}
          </AdminCard>
        </section>

        <section aria-labelledby="zero-trust-projects-heading">
          <AdminCard title="Project states" titleId="zero-trust-projects-heading">
            {projects.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Desired</TableHeaderCell>
                    <TableHeaderCell>Effective</TableHeaderCell>
                    <TableHeaderCell>State</TableHeaderCell>
                    <TableHeaderCell>Projects</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((entry) => (
                    <TableRow
                      key={`${entry.desiredProtected}:${entry.effectiveProtected}:${entry.state}`}
                    >
                      <TableCell>{entry.desiredProtected ? 'protected' : 'public'}</TableCell>
                      <TableCell>{entry.effectiveProtected ? 'protected' : 'public'}</TableCell>
                      <TableCell>{entry.state}</TableCell>
                      <TableCell>{entry.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p>No project protection state has been recorded.</p>
            )}
          </AdminCard>
        </section>

        <section aria-labelledby="zero-trust-configure-heading">
          <AdminCard
            title="Configure"
            titleId="zero-trust-configure-heading"
            description="The token needs Access Apps and Policies Write plus Organizations, Identity Providers, and Groups Read on the Cloudflare account that hosts this platform."
          >
            {operation && (
              <p>
                To replace an expired or revoked token, keep the saved settings and submit a new
                token. The pending operation will resume.
              </p>
            )}

            <SectionStack
              as="form"
              method="post"
              action={`${HOME}/configure`}
              className="void-admin-zero-trust-form"
            >
              {publicOnly && (
                <p>
                  Void manages public app rules for this account. Leave policy fields blank to
                  replace its token, or enter company identities and policies to configure
                  protection.
                </p>
              )}
              <FormTextInput
                label="API token"
                name="apiToken"
                type="password"
                autoComplete="new-password"
                required
                width={360}
              />
              <FormTextInput
                label="Identity provider IDs"
                name="identityProviderIds"
                initialValue={identityProviderIds.join(', ')}
                description={
                  publicOnly
                    ? 'Leave blank to keep public app rules, or enter company IDs to configure protection.'
                    : 'Separate IDs with commas or spaces.'
                }
                required={!publicOnly}
                width={480}
              />
              <FormTextInput
                label="Reusable policy IDs"
                name="policyIds"
                initialValue={policyIds.join(', ')}
                description="Separate IDs with commas or spaces."
                required={!publicOnly}
                width={480}
              />
              <FormCheckbox
                label="Protect new projects by default"
                name="protectNewProjects"
                submitValue="yes"
                initialValue={protectNewProjects ?? true}
              />
              {choosesExistingProjects && (
                <RadioList
                  label="Existing projects"
                  description="Applies when Zero Trust is enabled. Later changes use per-project overrides."
                  size="sm"
                  htmlName="existingProjects"
                  value={existingProjects}
                  onChange={(value: string) =>
                    setExistingProjects(value === 'public' ? 'public' : 'protected')
                  }
                >
                  <RadioListItem value="protected" label="Protect existing projects" />
                  <RadioListItem value="public" label="Keep existing projects public" />
                </RadioList>
              )}
              <Button type="submit" label="Save and reconcile" />
            </SectionStack>
          </AdminCard>
        </section>

        {configured && (
          <section aria-labelledby="zero-trust-maintenance-heading">
            <AdminCard title="Maintenance" titleId="zero-trust-maintenance-heading">
              <div className="void-admin-zero-trust-actions">
                <form method="post" action={`${HOME}/reconcile`}>
                  <Button type="submit" label="Reconcile drift" variant="secondary" />
                </form>
                {(enabled || operation) && (
                  <form
                    method="post"
                    action={`${HOME}/disable`}
                    data-confirm="Remove Void-managed Access protection? Apps may become public or be blocked by account-wide Default-Deny."
                  >
                    <Button
                      type="submit"
                      label={enabled ? 'Disable Zero Trust' : 'Cancel setup and clean up'}
                      variant="destructive"
                    />
                  </form>
                )}
              </div>
            </AdminCard>
          </section>
        )}
      </PageStack>
    </Layout>
  );
}
