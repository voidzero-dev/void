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
import { Heading } from '@astryxdesign/core/Text';
import { useRequest, useView } from 'react-fate';
import type { Invitation } from '../../../types.ts';
import { InvitationsView, invitationsRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { formatDateTime } from './format.ts';
import { FormTextArea } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import { SectionStack } from './SectionStack.tsx';

function StatusBadge({ status }: { status: Invitation['status'] }) {
  return (
    <Badge
      label={status}
      variant={status === 'pending' ? 'warning' : status === 'revoked' ? 'error' : 'neutral'}
    />
  );
}

export function InvitationsPage({ path, platformName, username }: AdminPageProps) {
  const { invitations: ref } = useRequest(invitationsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(InvitationsView, ref);
  if (!pageData) {
    throw new Error('Invitations are unavailable.');
  }
  const { invitations, page, totalPages, tz } = pageData;
  return (
    <Layout platformName={platformName} title="Invitations" username={username}>
      <SectionStack>
        <Heading level={1}>Invitations</Heading>

        <form method="post" action="/admin/invitations/send" className="void-admin-inline-form">
          <FormTextArea
            label="Email addresses"
            name="email"
            placeholder="user@example.com, teammate@example.com"
            required
            width={360}
          />
          <Button type="submit" label="Send Invites" />
        </form>

        <Table hasHover>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Email</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Invited By</TableHeaderCell>
              <TableHeaderCell>Sent</TableHeaderCell>
              <TableHeaderCell>Accepted At</TableHeaderCell>
              <TableHeaderCell>Revoked</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.map((inv) => (
              <TableRow key={inv.id}>
                <TableCell>{inv.email}</TableCell>
                <TableCell>
                  <StatusBadge status={inv.status} />
                </TableCell>
                <TableCell>{inv.invited_by_login ?? inv.invited_by}</TableCell>
                <TableCell>{inv.created_at ? formatDateTime(inv.created_at, tz) : '-'}</TableCell>
                <TableCell>{inv.accepted_at ? formatDateTime(inv.accepted_at, tz) : '-'}</TableCell>
                <TableCell>
                  {inv.revoked_at ? (
                    <>
                      {formatDateTime(inv.revoked_at, tz)} by{' '}
                      {inv.revoked_by_login ?? inv.revoked_by ?? '?'}
                    </>
                  ) : (
                    '-'
                  )}
                </TableCell>
                <TableCell>
                  {inv.status === 'pending' && (
                    <form
                      method="post"
                      action="/admin/invitations/revoke"
                      style={{ display: 'inline' }}
                    >
                      <input type="hidden" name="id" defaultValue={inv.id} />
                      <Button type="submit" label="Revoke" variant="destructive" size="sm" />
                    </form>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {invitations.length === 0 && (
          <p>
            <em>No invitations yet.</em>
          </p>
        )}

        <Pagination page={page} totalPages={totalPages} baseUrl="/admin/invitations" />
      </SectionStack>
    </Layout>
  );
}
