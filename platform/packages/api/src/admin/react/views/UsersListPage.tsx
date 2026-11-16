/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { Link } from '@void/react';
import { useEffect, useState } from 'react';
import { useRequest, useView } from 'react-fate';
import type { AdminUsersPage } from '../../fate/server.ts';
import { UsersPageView, usersPageRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';
import { Pagination } from './Pagination.tsx';
import { SearchForm } from './SearchForm.tsx';
import { SectionStack } from './SectionStack.tsx';

type UserRow = AdminUsersPage['users'][number];

export function UsersListPage({ path, platformName, username }: AdminPageProps) {
  const { usersPage: ref } = useRequest(usersPageRequest(path), { mode: 'stale-while-revalidate' });
  const pageData = useView(UsersPageView, ref);
  if (!pageData) {
    throw new Error('Users page data is unavailable.');
  }
  const { users, search, page, totalPages, tz } = pageData;
  const [filter, setFilter] = useState(search ?? '');
  useEffect(() => setFilter(search ?? ''), [search]);
  const selectedUser = pageData.suggestions.find((item) => item.id === search);
  const columns: Array<TableColumn<UserRow>> = [
    {
      key: 'login',
      header: 'Login',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (user: UserRow) => (
        <Link
          className="void-admin-resource-link void-admin-user-link"
          href={`/admin/users/${user.id}`}
          title={user.login}
        >
          {user.login}
        </Link>
      ),
    },
    { key: 'provider', header: 'Provider', width: pixel(88) },
    {
      key: 'email',
      header: 'Email',
      width: proportional(2, { minWidth: 220 }),
      renderCell: (user: UserRow) => <Text maxLines={1}>{user.email ?? '-'}</Text>,
    },
    { key: 'plan', header: 'Plan', width: pixel(100) },
    { key: 'role', header: 'Role', width: pixel(68) },
    {
      key: 'suspended_reason',
      header: 'Status',
      width: pixel(100),
      renderCell: (user: UserRow) => (user.suspended_reason ? 'suspended' : 'active'),
    },
    {
      key: 'created_at',
      header: 'Created',
      width: pixel(220),
      renderCell: (user: UserRow) => formatDateTime(user.created_at, tz),
    },
    {
      key: 'actions',
      header: 'Actions',
      width: pixel(108),
      renderCell: (user: UserRow) => (
        <form
          method="post"
          action={`/admin/users/${user.id}/delete`}
          data-confirm={`Delete user "${user.login}" and all their projects?`}
        >
          <Button type="submit" label="Delete" variant="destructive" size="sm" />
        </form>
      ),
    },
  ];
  return (
    <Layout platformName={platformName} title="Users" username={username}>
      <SectionStack>
        <h1>Users</h1>
        <SearchForm
          action="/admin/users"
          kind="users"
          label="Search users"
          value={filter}
          onChange={setFilter}
          initialValue={search}
          initialSelection={selectedUser}
        />
        <Table
          className="void-admin-users-table"
          data={[...users]}
          columns={columns}
          idKey="id"
          textOverflow="truncate"
          hasHover
        />
        {users.length === 0 && (
          <p>
            <em>No users found.</em>
          </p>
        )}
        {page != null && totalPages != null && (
          <Pagination page={page} totalPages={totalPages} baseUrl="/admin/users" />
        )}
      </SectionStack>
    </Layout>
  );
}
