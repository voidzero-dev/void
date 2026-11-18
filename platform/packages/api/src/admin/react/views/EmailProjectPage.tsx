/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Link } from '@void/react';
import { useRequest, useView } from 'react-fate';
import {
  DEFAULT_EMAIL_BURST_LIMIT as DEFAULT_BURST_LIMIT,
  DEFAULT_EMAIL_MONTHLY_LIMIT as DEFAULT_MONTHLY_LIMIT,
} from '../../../email/limits.ts';
import { EmailProjectView, emailProjectRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { STATUS_COLORS, formatDateTime } from './format.ts';
import { FormNumberInput, FormTextInput } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { SectionStack } from './SectionStack.tsx';
const META = { fontSize: '0.8rem', color: '#666' };
function domainStatusColor(status: string): string {
  if (status === 'ready' || status === 'healthy') {
    return STATUS_COLORS.success;
  }
  if (status === 'pending' || status === 'verified_only' || status === 'probe_failed') {
    return STATUS_COLORS.pending;
  }
  return STATUS_COLORS.failed;
}
export function EmailProjectPage({ path, platformName, username }: AdminPageProps) {
  const { emailProject: ref } = useRequest(emailProjectRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(EmailProjectView, ref);
  if (!pageData) {
    throw new Error('Project email data is unavailable.');
  }
  const {
    projectId,
    project,
    month,
    attempts,
    received,
    monthlyLimit,
    burstLimit,
    isSuspended,
    domains,
    destinations,
    senderDomain,
    tz,
  } = pageData;
  return (
    <Layout platformName={platformName} title={`Email - ${project.slug}`} username={username}>
      <SectionStack>
        <h1>
          Email &mdash; <Link href={`/admin/projects/${projectId}`}>{project.slug}</Link>
        </h1>

        <Table>
          <TableBody>
            <TableRow>
              <TableHeaderCell>Project ID</TableHeaderCell>
              <TableCell>{projectId}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Sender</TableHeaderCell>
              <TableCell>
                {senderDomain ? (
                  <code>{`${project.slug}+noreply@${senderDomain}`}</code>
                ) : (
                  <em>EMAIL_SENDER_DOMAIN is not configured for this environment</em>
                )}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableCell>
                {isSuspended ? (
                  <strong style={{ color: 'red' }}>SUSPENDED</strong>
                ) : (
                  <span style={{ color: '#16a34a' }}>active</span>
                )}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </SectionStack>

      <SectionStack>
        <h2>Usage ({month})</h2>
        <Table>
          <TableBody>
            <TableRow>
              <TableHeaderCell>Outbound recipient attempts</TableHeaderCell>
              <TableCell>
                {attempts} / {monthlyLimit ?? DEFAULT_MONTHLY_LIMIT}{' '}
                <span style={META}>({monthlyLimit === undefined ? 'default' : 'override'})</span>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Inbound (received)</TableHeaderCell>
              <TableCell>{received}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Burst cap</TableHeaderCell>
              <TableCell>
                {burstLimit ?? DEFAULT_BURST_LIMIT} / minute{' '}
                <span style={META}>({burstLimit === undefined ? 'default' : 'override'})</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <p style={META}>
          Recipient submission attempts and inbound receipts are recorded in the platform database.
        </p>
      </SectionStack>

      <SectionStack>
        <h2>Controls</h2>
        <SectionStack as="form" method="post" action={`/admin/email/${projectId}/suspend`}>
          {/* Post the desired terminal state rather than a "toggle" intent, so a
            double-click cannot race two toggles and flip the switch back on. */}
          <input type="hidden" name="state" defaultValue={isSuspended ? 'active' : 'suspended'} />
          <Button
            type="submit"
            label={isSuspended ? 'Unsuspend email' : 'Suspend email'}
            variant={isSuspended ? 'secondary' : 'destructive'}
          />{' '}
          <span style={META}>
            Suspending stops new outbound attempts and rejects new inbound messages with a permanent
            SMTP error. Outbound submissions that already started may still finish. There is no
            per-direction switch.
          </span>
        </SectionStack>

        <SectionStack as="form" method="post" action={`/admin/email/${projectId}/limit`}>
          <FormNumberInput label="Monthly limit" name="limit" width={200} />
          <Button type="submit" label="Set monthly limit" />{' '}
          <span style={META}>Submit blank to drop the override back to the platform default.</span>
        </SectionStack>

        <SectionStack as="form" method="post" action={`/admin/email/${projectId}/burst-limit`}>
          <FormNumberInput label="Burst limit" name="burstLimit" width={200} />
          <Button type="submit" label="Set burst limit" />{' '}
          <span style={META}>Per-minute cap. Submit blank to drop the override.</span>
        </SectionStack>
      </SectionStack>

      <SectionStack>
        <h2>Verified destinations ({destinations.length})</h2>
        <p style={META}>
          Recipient addresses this project is allowed to send to. A <code>pending</code> row is
          waiting on the recipient clicking their verification link. Removing a row revokes it for
          this project only; the Cloudflare account-level address is deleted just when no other
          project still references it.
        </p>
        {destinations.length === 0 ? (
          <p>
            <em>No destinations yet.</em>
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Address</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Source</TableHeaderCell>
                <TableHeaderCell>Verified</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {destinations.map((destination) => (
                <TableRow key={destination.id}>
                  <TableCell>{destination.address}</TableCell>
                  <TableCell>
                    {destination.status === 'verified' ? (
                      <span style={{ color: '#16a34a' }}>verified</span>
                    ) : (
                      <span style={{ color: '#d97706' }}>pending</span>
                    )}
                  </TableCell>
                  <TableCell>{destination.verification_source}</TableCell>
                  <TableCell>
                    {destination.verified_at ? formatDateTime(destination.verified_at, tz) : '-'}
                  </TableCell>
                  <TableCell>
                    <form
                      method="post"
                      action={`/admin/email/${projectId}/destinations/${destination.id}/delete`}
                      data-confirm={`Remove "${destination.address}" from this project?`}
                    >
                      <Button type="submit" label="Remove" variant="destructive" size="sm" />
                    </form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p style={META}>
          Destinations are added by the project owner through{' '}
          <code>POST /projects/:id/email/destinations</code>, which emails the recipient for
          consent. There is deliberately no operator-side "add" here: an admin cannot consent on a
          recipient's behalf.
        </p>
      </SectionStack>

      <SectionStack>
        <h2>Custom domains ({domains.length})</h2>
        <p style={META}>
          Exact sender and recipient domains on a Cloudflare zone. One connection owns the ingress
          Worker and catch-all; removing an assignment keeps shared resources while sibling domains
          use them. The platform stores connection credentials and never shows them here.
        </p>
        <form
          method="post"
          action={`/admin/email/${projectId}/domains/add`}
          className="void-admin-inline-form"
        >
          <FormTextInput
            label="Domain"
            name="domain"
            placeholder="mail.example.com"
            autoComplete="off"
            required
            width={240}
          />
          <FormTextInput
            label="API token"
            name="token"
            type="password"
            placeholder="Blank = platform credential"
            autoComplete="off"
            width={300}
          />
          <Button type="submit" label="Add domain" />
        </form>
        {domains.length === 0 ? (
          <p>
            <em>No custom domains.</em>
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Domain</TableHeaderCell>
                <TableHeaderCell>Inbound</TableHeaderCell>
                <TableHeaderCell>Outbound</TableHeaderCell>
                <TableHeaderCell>Management</TableHeaderCell>
                <TableHeaderCell>Managed by</TableHeaderCell>
                <TableHeaderCell>Ingress worker</TableHeaderCell>
                <TableHeaderCell>v</TableHeaderCell>
                <TableHeaderCell>Latest operation</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.map((domain) => (
                <TableRow key={domain.id}>
                  <TableCell>{domain.domain}</TableCell>
                  <TableCell>
                    <span style={{ color: domainStatusColor(domain.inbound) }}>
                      {domain.inbound}
                    </span>
                    {domain.inboundReason && <small> — {domain.inboundReason}</small>}
                  </TableCell>
                  <TableCell>
                    <span style={{ color: domainStatusColor(domain.outbound) }}>
                      {domain.outbound}
                    </span>
                    {domain.outboundReason && <small> — {domain.outboundReason}</small>}
                  </TableCell>
                  <TableCell>
                    <span style={{ color: domainStatusColor(domain.management) }}>
                      {domain.management}
                    </span>
                    {domain.managementReason && <small> — {domain.managementReason}</small>}
                  </TableCell>
                  <TableCell>{domain.managed_by}</TableCell>
                  <TableCell>{domain.relay_worker_name ?? '-'}</TableCell>
                  <TableCell>{domain.relay_version ?? '-'}</TableCell>
                  <TableCell>
                    {domain.operation ? (
                      <>
                        <code>{domain.operation.id}</code> ({domain.operation.status})
                      </>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    <SectionStack as="div" gap={2}>
                      <form
                        method="post"
                        action={`/admin/email/${projectId}/domains/${domain.domain}/rotate-secret`}
                      >
                        <Button type="submit" label="Rotate secret" size="sm" />
                      </form>
                      {/* The typed slug is the real confirmation; the server checks it. */}
                      <SectionStack
                        as="form"
                        gap={2}
                        method="post"
                        action={`/admin/email/${projectId}/domains/${domain.domain}/revoke`}
                        data-confirm={`Remove "${domain.domain}"? This disables its exact assignment. Shared ingress stays while another domain uses it.`}
                      >
                        <FormTextInput
                          label="Confirm project name"
                          name="confirm"
                          placeholder={project.slug}
                          autoComplete="off"
                          required
                          width={190}
                        />
                        <Button type="submit" label="Revoke" variant="destructive" size="sm" />
                      </SectionStack>
                    </SectionStack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionStack>
    </Layout>
  );
}
