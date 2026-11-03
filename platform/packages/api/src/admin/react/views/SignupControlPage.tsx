/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { useClipboard } from '@astryxdesign/core/hooks';
import { InputGroup } from '@astryxdesign/core/InputGroup';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Heading } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Check, Copy } from 'lucide-react';
import { createElement, useState, type FocusEvent } from 'react';
import { useRequest, useView } from 'react-fate';
import { SignupView, signupRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { AdminCard } from './AdminCard.tsx';
import { formatDateTime } from './format.ts';
import { FormCheckbox, FormSelector, FormTextArea, FormTextInput } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { Pagination } from './Pagination.tsx';
import { SectionStack } from './SectionStack.tsx';

function BooleanBadge({ value }: { value: boolean }) {
  return <Badge label={value ? 'Yes' : 'No'} variant={value ? 'success' : 'neutral'} />;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const { copy, isCopied } = useClipboard({ announce: `${label} copied` });
  const [failed, setFailed] = useState(false);
  return (
    <div className="void-admin-access-copy-value">
      <InputGroup label={label}>
        <TextInput
          label=""
          isReadOnly
          value={value}
          onFocus={(event: FocusEvent<HTMLInputElement>) => event.currentTarget.select()}
        />
        <Button
          type="button"
          label={`${isCopied ? 'Copied' : 'Copy'} ${label}`}
          tooltip={isCopied ? 'Copied' : 'Copy'}
          icon={createElement(isCopied ? Check : Copy, { size: 16, 'aria-hidden': true })}
          isIconOnly
          variant="ghost"
          size="sm"
          onClick={async () => setFailed(!(await copy(value)))}
        />
      </InputGroup>
      {failed && <span role="status">Select the value to copy it manually.</span>}
    </div>
  );
}

function DeliveryBadge({ status }: { status: string | null }) {
  if (status === 'sent') {
    return <Badge label="Sent" variant="success" />;
  }
  if (status === 'failed') {
    return <Badge label="Failed" variant="error" />;
  }
  if (status === 'unavailable') {
    return <Badge label="Email off" variant="neutral" />;
  }
  return <Badge label="Not recorded" variant="neutral" />;
}

export function SignupControlPage({ path, platformName, username }: AdminPageProps) {
  const { signupControl: ref } = useRequest(signupRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(SignupView, ref);
  if (!pageData) {
    throw new Error('Access settings are unavailable.');
  }
  const {
    enabled,
    admission,
    initialized,
    revision,
    methods,
    protection,
    connections,
    directEntries,
    invitations,
    page,
    totalPages,
    emailEnabled,
    connectCommand,
    inviteUrl,
    result,
    tz,
  } = pageData;
  const mode = admission?.mode ?? (enabled ? 'restricted' : 'public');
  const companyMethods = methods.filter((method) => method.enabled && method.kind !== 'github');

  return (
    <Layout platformName={platformName} title="Access" username={username}>
      <PageStack className="void-admin-access-page">
        <SectionStack as="header" className="void-admin-access-intro">
          <Heading level={1}>Access</Heading>
          <p>Decide who can join this platform and manage invitations and individual grants.</p>
        </SectionStack>

        <section aria-labelledby="access-policy-heading">
          <AdminCard
            title="Who can join?"
            titleId="access-policy-heading"
            description="These rules apply when someone creates a platform account."
            headerAccessory={
              <Badge
                label={
                  mode === 'public'
                    ? 'Public'
                    : mode === 'company'
                      ? 'Company or approved'
                      : 'Approved only'
                }
                variant={mode === 'public' ? 'warning' : 'neutral'}
              />
            }
          >
            {initialized ? (
              <SectionStack
                as="form"
                method="post"
                action="/admin/signup-control/policy"
                className="void-admin-access-form"
              >
                <input type="hidden" name="revision" value={revision ?? 0} />
                <FormSelector
                  label="Signup policy"
                  name="mode"
                  initialValue={mode}
                  options={[
                    { value: 'restricted', label: 'Only individually approved people' },
                    { value: 'company', label: 'Company-approved or individually approved people' },
                    { value: 'public', label: 'Anyone with an enabled login method' },
                  ]}
                  width={420}
                />
                <p>
                  {mode === 'restricted'
                    ? 'An invitation or direct grant is required before someone can create an account.'
                    : mode === 'company'
                      ? 'People who meet a selected company policy or have an individual grant can join.'
                      : 'Anyone with an enabled login method can join. Individual invitations are unnecessary.'}
                </p>
                <AdminCard
                  title="Company-approved methods"
                  headingLevel={3}
                  description="Select which existing login checks qualify someone when company signup is chosen."
                >
                  <div className="void-admin-access-checkboxes">
                    {companyMethods.map((method) => (
                      <FormCheckbox
                        key={method.id}
                        label={method.label}
                        name="connections"
                        submitValue={method.id}
                        initialValue={
                          admission?.mode === 'company' && admission.connections.includes(method.id)
                        }
                      />
                    ))}
                    {protection && (
                      <FormCheckbox
                        label="Anyone who passes Cloudflare Access protection"
                        name="access"
                        submitValue="true"
                        initialValue={admission?.mode === 'company' && admission.access}
                      />
                    )}
                    {companyMethods.length === 0 && !protection && (
                      <p>
                        No company-approved methods are available. Configure one in{' '}
                        <a href="/admin/config/auth">Authentication</a> before selecting this
                        policy.
                      </p>
                    )}
                  </div>
                </AdminCard>
                <p>
                  New accounts are ordinary users. Changing this policy does not change Cloudflare
                  Access protection.
                </p>
                <Button type="submit" label="Save signup policy" />
              </SectionStack>
            ) : (
              <SectionStack as="div" className="void-admin-access-form">
                <p>
                  To use company-approved signup, first set up{' '}
                  <a href="/admin/config/auth">Authentication settings</a>.
                </p>
                <SectionStack
                  as="form"
                  method="post"
                  action="/admin/signup-control/toggle"
                  className="void-admin-access-form"
                >
                  <p>
                    Signup is{' '}
                    {enabled
                      ? 'restricted to approved people'
                      : 'open to anyone with an enabled login'}
                    .
                  </p>
                  <Button
                    type="submit"
                    label={enabled ? 'Open signup' : 'Restrict signup'}
                    variant="secondary"
                  />
                </SectionStack>
              </SectionStack>
            )}
          </AdminCard>
        </section>

        <section aria-labelledby="access-invite-heading">
          <AdminCard
            title="Invite people"
            titleId="access-invite-heading"
            description={
              mode === 'public'
                ? 'Signup is public. Share the platform address with anyone you want to join.'
                : emailEnabled
                  ? "Create an invitation for each email address. We'll email them connection instructions."
                  : 'Create an invitation for each email address. Since email is off, share the platform link below yourself.'
            }
            headerAccessory={
              <Badge
                label={emailEnabled ? 'Email enabled' : 'Email not enabled'}
                variant={emailEnabled ? 'success' : 'neutral'}
              />
            }
          >
            {result === 'invited' && (
              <p role="status" className="void-admin-access-notice">
                {emailEnabled
                  ? 'Invitations created. Check the history below to see whether email was sent.'
                  : 'Invitations created. Share the platform link below with each person.'}
              </p>
            )}
            {mode !== 'public' && (
              <SectionStack
                as="form"
                method="post"
                action="/admin/invitations/send"
                className="void-admin-access-form"
              >
                <FormTextArea
                  label="Email addresses"
                  name="email"
                  placeholder="person@example.com, teammate@example.com"
                  required
                  width={440}
                />
                <p>
                  Each person must sign in with a login method that supplies the same verified email
                  address.
                </p>
                <Button
                  type="submit"
                  label={emailEnabled ? 'Invite and email' : 'Create invitations'}
                />
              </SectionStack>
            )}
            <SectionStack as="div" className="void-admin-access-share">
              <h3>{emailEnabled ? 'Share connection details' : 'Share these details manually'}</h3>
              <CopyValue label="Platform invitation page" value={inviteUrl} />
              <CopyValue label="Void CLI connection command" value={connectCommand} />
            </SectionStack>
          </AdminCard>
        </section>

        <section aria-labelledby="access-grants-heading">
          <AdminCard
            title="Direct grants"
            titleId="access-grants-heading"
            description={
              <>
                Allow a GitHub username, email address or domain, or login identity to sign up.
                These rules do not create invitations or send email.
                {mode === 'public' && ' While signup is public, grants do not limit who can join.'}
              </>
            }
          >
            <form
              method="post"
              action="/admin/signup-control/add"
              className="void-admin-access-fields"
            >
              <FormSelector
                label="Grant type"
                name="type"
                initialValue="github"
                options={[
                  { value: 'github', label: 'GitHub username' },
                  { value: 'email', label: 'Email or domain pattern' },
                ]}
                width={210}
              />
              <FormTextArea
                label="Pattern"
                name="pattern"
                placeholder="username, person@example.com, *@company.com"
                required
                width={360}
              />
              <FormTextInput label="Note" name="note" placeholder="Optional" width={180} />
              <Button type="submit" label="Add grant" />
            </form>
            {connections.length > 0 && (
              <form
                method="post"
                action="/admin/signup-control/add"
                className="void-admin-access-fields"
              >
                <input type="hidden" name="type" value="identity" />
                <FormSelector
                  label="Login connection"
                  name="connectionId"
                  initialValue={connections[0]?.id ?? ''}
                  options={connections.map((connection) => ({
                    value: connection.id,
                    label: `${connection.label} (${connection.id})`,
                  }))}
                  width={250}
                  hasSearch
                />
                <FormTextInput
                  label="Provider subject"
                  name="subject"
                  placeholder="Exact provider subject"
                  required
                  maxLength={255}
                  width={340}
                />
                <FormTextInput label="Note" name="note" placeholder="Optional" width={180} />
                <Button type="submit" label="Add identity" />
              </form>
            )}
            <p>
              Identity grants match the selected login connection and provider subject exactly,
              including case. Email is not inferred or linked.
            </p>
            <div className="void-admin-access-table">
              <Table hasHover>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Grant</TableHeaderCell>
                    <TableHeaderCell>Note</TableHeaderCell>
                    <TableHeaderCell>Accepted</TableHeaderCell>
                    <TableHeaderCell>Deployed</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {directEntries.map((entry) => (
                    <TableRow
                      key={
                        entry.type === 'identity'
                          ? `${entry.type}-${entry.connectionId}-${entry.subject}`
                          : `${entry.type}-${entry.pattern}`
                      }
                    >
                      <TableCell>{entry.type}</TableCell>
                      <TableCell>
                        {entry.type === 'identity'
                          ? `${entry.connectionId}: ${entry.subject}`
                          : entry.pattern}
                      </TableCell>
                      <TableCell>{entry.note || '—'}</TableCell>
                      <TableCell>
                        <BooleanBadge value={entry.accepted} />
                      </TableCell>
                      <TableCell>
                        <BooleanBadge value={entry.deployed} />
                      </TableCell>
                      <TableCell>
                        <form method="post" action="/admin/signup-control/delete">
                          <input type="hidden" name="index" value={entry.index} />
                          <Button type="submit" label="Remove" variant="destructive" size="sm" />
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {directEntries.length === 0 && <p>No direct grants yet.</p>}
          </AdminCard>
        </section>

        <section aria-labelledby="access-history-heading">
          <AdminCard
            title="Invitation history"
            titleId="access-history-heading"
            description="Invitation status and email delivery are tracked separately. Invitations do not expire."
            footer={
              totalPages > 1 ? (
                <Pagination page={page} totalPages={totalPages} baseUrl="/admin/signup-control" />
              ) : undefined
            }
          >
            <div className="void-admin-access-table">
              <Table hasHover className="void-admin-invitations-table">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Email</TableHeaderCell>
                    <TableHeaderCell>Access</TableHeaderCell>
                    <TableHeaderCell>Email delivery</TableHeaderCell>
                    <TableHeaderCell>Invited by</TableHeaderCell>
                    <TableHeaderCell>Created</TableHeaderCell>
                    <TableHeaderCell>Accepted</TableHeaderCell>
                    <TableHeaderCell>Revoked</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.map((invitation) => (
                    <TableRow key={invitation.id}>
                      <TableCell>{invitation.email}</TableCell>
                      <TableCell>
                        <Badge
                          label={invitation.status}
                          variant={
                            invitation.status === 'pending'
                              ? 'warning'
                              : invitation.status === 'revoked'
                                ? 'error'
                                : 'success'
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <DeliveryBadge status={invitation.email_delivery_status} />
                      </TableCell>
                      <TableCell>{invitation.invited_by_login ?? invitation.invited_by}</TableCell>
                      <TableCell>
                        {invitation.created_at ? formatDateTime(invitation.created_at, tz) : '—'}
                      </TableCell>
                      <TableCell>
                        {invitation.accepted_at ? formatDateTime(invitation.accepted_at, tz) : '—'}
                      </TableCell>
                      <TableCell>
                        {invitation.revoked_at ? (
                          <>
                            {formatDateTime(invitation.revoked_at, tz)} by{' '}
                            {invitation.revoked_by_login ?? invitation.revoked_by ?? '?'}
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        {invitation.status === 'pending' && (
                          <form method="post" action="/admin/invitations/revoke">
                            <input type="hidden" name="id" value={invitation.id} />
                            <Button type="submit" label="Revoke" variant="destructive" size="sm" />
                          </form>
                        )}
                        {invitation.status === 'accepted' && invitation.grantIndex !== null && (
                          <form method="post" action="/admin/signup-control/delete">
                            <input type="hidden" name="index" value={invitation.grantIndex} />
                            <Button
                              type="submit"
                              label="Remove signup grant"
                              variant="destructive"
                              size="sm"
                            />
                          </form>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {invitations.length === 0 && <p>No invitations yet.</p>}
          </AdminCard>
        </section>
      </PageStack>
    </Layout>
  );
}
