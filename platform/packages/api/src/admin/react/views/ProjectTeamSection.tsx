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
import { useMemo, useState } from 'react';
import type { ProjectMemberRole } from '../../../types.ts';
import { AdminUserTypeahead } from './AdminUserTypeahead.tsx';
import type { AdminUserSuggestion } from './AdminUserTypeahead.tsx';
import { formatDateTime } from './format.ts';
import { FormSelector } from './FormControls.tsx';
import { PageStack } from './PageStack.tsx';
import { SectionStack } from './SectionStack.tsx';

type TeamMember = Readonly<{
  user: Readonly<{ id: string; login: string; email: string | null }>;
  role: ProjectMemberRole;
  createdAt: string;
}>;
type PendingInvitation = Readonly<{
  id: string;
  targetUserId: string;
  email: string;
  role: ProjectMemberRole;
  expiresAt: string;
}>;
const roleOptions = [
  { value: 'reader', label: 'Reader' },
  { value: 'collaborator', label: 'Collaborator' },
  { value: 'admin', label: 'Admin' },
];

export function ProjectTeamSection({
  projectId,
  owner,
  members,
  invitations,
  tz,
}: {
  projectId: string;
  owner: Readonly<{ id: string; login: string }> | null;
  members: ReadonlyArray<TeamMember>;
  invitations: ReadonlyArray<PendingInvitation>;
  tz?: string;
}) {
  const [selected, setSelected] = useState<AdminUserSuggestion | null>(null);
  const excluded = useMemo(
    () => new Set([...(owner ? [owner.id] : []), ...members.map(({ user }) => user.id)]),
    [owner, members],
  );

  return (
    <PageStack as="section" id="team" className="void-admin-project-team">
      <SectionStack>
        <h2>Team members ({members.length + 1})</h2>
        <p>Add an existing platform user to this project with the selected role.</p>
        <div className="void-admin-team-table-scroll">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell>Role</TableHeaderCell>
                <TableHeaderCell>Joined</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>
                  {owner ? (
                    <a className="void-admin-resource-link" href={`/admin/users/${owner.id}`}>
                      {owner.login}
                    </a>
                  ) : (
                    'Owner account unavailable'
                  )}
                </TableCell>
                <TableCell>Owner</TableCell>
                <TableCell>—</TableCell>
                <TableCell>
                  <Button
                    as="a"
                    href="#owner-transfer"
                    label="Transfer ownership"
                    variant="secondary"
                    size="sm"
                  />
                </TableCell>
              </TableRow>
              {members.map(({ user, role, createdAt }) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <a className="void-admin-resource-link" href={`/admin/users/${user.id}`}>
                      {user.login}
                    </a>
                    {user.email && <span className="void-admin-team-email">{user.email}</span>}
                  </TableCell>
                  <TableCell>{role}</TableCell>
                  <TableCell>{formatDateTime(createdAt, tz)}</TableCell>
                  <TableCell>
                    <div className="void-admin-team-actions">
                      <form
                        method="post"
                        action={`/admin/projects/${projectId}/team/${user.id}/role`}
                      >
                        <FormSelector
                          label={`Role for ${user.login}`}
                          name="role"
                          options={roleOptions}
                          initialValue={role}
                          width={160}
                        />
                        <Button type="submit" label="Save role" size="sm" />
                      </form>
                      <form
                        method="post"
                        action={`/admin/projects/${projectId}/team/${user.id}/remove`}
                        data-confirm={`Remove ${user.login} from this project?`}
                      >
                        <Button type="submit" label="Remove" variant="destructive" size="sm" />
                      </form>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionStack>

      <SectionStack>
        <h3>Add team member</h3>
        <form
          className="void-admin-team-add"
          method="post"
          action={`/admin/projects/${projectId}/team/add`}
        >
          <AdminUserTypeahead
            label="Search registered users"
            selected={selected}
            onChange={setSelected}
            excludedUserIds={excluded}
          />
          <input type="hidden" name="userId" value={selected?.id ?? ''} />
          <FormSelector
            label="Project role"
            name="role"
            options={roleOptions}
            initialValue="reader"
            width={180}
          />
          <Button type="submit" label="Add member" isDisabled={!selected} />
        </form>
      </SectionStack>

      {invitations.length > 0 && (
        <SectionStack>
          <h3>Pending invitations ({invitations.length})</h3>
          <p>
            If email delivery is unavailable, share the invitation ID and ask the user to run{' '}
            <code>void project team accept &lt;invitation-id&gt;</code>.
          </p>
          <div className="void-admin-team-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Email</TableHeaderCell>
                  <TableHeaderCell>Role</TableHeaderCell>
                  <TableHeaderCell>Invitation ID</TableHeaderCell>
                  <TableHeaderCell>Expires</TableHeaderCell>
                  <TableHeaderCell>Action</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>{invitation.email}</TableCell>
                    <TableCell>{invitation.role}</TableCell>
                    <TableCell>
                      <code>{invitation.id}</code>
                    </TableCell>
                    <TableCell>{formatDateTime(invitation.expiresAt, tz)}</TableCell>
                    <TableCell>
                      <form
                        method="post"
                        action={`/admin/projects/${projectId}/team/invitations/${invitation.id}/revoke`}
                        data-confirm={`Revoke the invitation for ${invitation.email}?`}
                      >
                        <Button type="submit" label="Revoke" variant="destructive" size="sm" />
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionStack>
      )}
    </PageStack>
  );
}
