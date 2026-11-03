/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Button } from '@astryxdesign/core/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { useRequest, useView } from 'react-fate';
import { UserDetailView, userDetailRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import {
  formatLimit,
  formatNumber,
  formatBytes,
  formatAbsoluteDate,
  formatDateTime,
} from './format.ts';
import { FormSelector, FormTextInput } from './FormControls.tsx';
import { Layout } from './Layout.tsx';
import { SectionStack } from './SectionStack.tsx';

export function UserDetailPage({ path, platformName, username }: AdminPageProps) {
  const { userDetail: ref } = useRequest(userDetailRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(UserDetailView, ref);
  if (!pageData) {
    throw new Error('User data is unavailable.');
  }
  const { user, projects, deploysToday, usage, tz, plans, limits } = pageData;

  return (
    <Layout platformName={platformName} title={user.login} username={username}>
      <SectionStack>
        <h1>{user.login}</h1>

        <Table className="void-admin-detail-table">
          <TableBody>
            <TableRow>
              <TableHeaderCell>ID</TableHeaderCell>
              <TableCell>{user.id}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Provider</TableHeaderCell>
              <TableCell>{user.provider}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Email</TableHeaderCell>
              <TableCell>{user.email ?? '-'}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableCell>{user.role}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableCell>
                {user.suspended_reason ? `suspended: ${user.suspended_reason}` : 'active'}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableCell>{formatDateTime(user.created_at, tz)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </SectionStack>

      <SectionStack>
        <h2>Plan</h2>
        <form
          method="post"
          action={`/admin/users/${user.id}/plan`}
          className="void-admin-inline-form"
        >
          <FormSelector
            label="Plan"
            name="plan"
            initialValue={user.plan}
            options={plans.map((plan) => ({
              value: plan.id,
              label: plan.archived ? `${plan.name} (archived)` : plan.name,
            }))}
          />
          <Button type="submit" label="Update" />
        </form>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Limit</TableHeaderCell>
              <TableHeaderCell>Value</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Requests / month</TableCell>
              <TableCell>{formatLimit(limits.requestsPerMonth)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>CPU ms / request</TableCell>
              <TableCell>{formatLimit(limits.cpuMsPerRequest)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Sub-requests / invocation</TableCell>
              <TableCell>{formatLimit(limits.subRequestsPerInvocation)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Deploys / day</TableCell>
              <TableCell>
                {deploysToday} / {formatLimit(limits.deploysPerDay)}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>D1 storage</TableCell>
              <TableCell>{formatLimit(limits.d1StorageBytes, 'bytes')}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>R2 storage</TableCell>
              <TableCell>{formatLimit(limits.r2StorageBytes, 'bytes')}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>KV storage</TableCell>
              <TableCell>{formatLimit(limits.kvStorageBytes, 'bytes')}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>AI neurons / month</TableCell>
              <TableCell>{formatLimit(limits.aiNeuronsPerMonth)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Retained deployments</TableCell>
              <TableCell>{formatLimit(limits.retainedDeployments)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </SectionStack>

      <SectionStack>
        <h2>Current Usage (since {formatAbsoluteDate(usage.billingPeriodStart)})</h2>
        <p>
          Requests: {formatNumber(usage.totalRequests)} / {formatLimit(limits.requestsPerMonth)}
        </p>
        <p>
          Deploys today: {formatNumber(deploysToday)} / {formatLimit(limits.deploysPerDay)}
        </p>
        <p>Bandwidth: {formatBytes(usage.totalBandwidth)}</p>
        {usage.projects.length > 1 && (
          <SectionStack>
            <h3>Per Project</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Project</TableHeaderCell>
                  <TableHeaderCell>Requests</TableHeaderCell>
                  <TableHeaderCell>Bandwidth</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.projects.map((p) => (
                  <TableRow key={p.projectId}>
                    <TableCell>
                      <a
                        className="void-admin-resource-link"
                        href={`/admin/projects/${p.projectId}`}
                      >
                        {p.slug}
                      </a>
                    </TableCell>
                    <TableCell>{formatNumber(p.requests)}</TableCell>
                    <TableCell>{formatBytes(p.bandwidthBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SectionStack>
        )}
      </SectionStack>

      <SectionStack>
        <h2>Suspension</h2>
        {user.suspended_reason ? (
          <form method="post" action={`/admin/users/${user.id}/unsuspend`}>
            <Button type="submit" label="Unsuspend" />
          </form>
        ) : (
          <SectionStack
            as="form"
            maxWidth={320}
            method="post"
            action={`/admin/users/${user.id}/suspend`}
            data-confirm={`Suspend "${user.login}" and ${projects.length} project(s)? Requests, cron jobs and queue delivery stop. Queue messages are dropped when their retries run out, after about 3 hours by default. Restore does not bring them back.`}
          >
            <FormTextInput
              label="Reason"
              name="reason"
              initialValue="admin_suspended"
              placeholder="Reason..."
            />
            <Button type="submit" label="Suspend" variant="destructive" />
          </SectionStack>
        )}
      </SectionStack>

      <SectionStack>
        <h2>Projects ({projects.length})</h2>
        {projects.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <a className="void-admin-resource-link" href={`/admin/projects/${p.id}`}>
                      {p.slug}
                    </a>
                  </TableCell>
                  <TableCell>{p.type}</TableCell>
                  <TableCell>{formatDateTime(p.created_at, tz)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p>
            <em>No projects.</em>
          </p>
        )}
      </SectionStack>

      <SectionStack>
        <h2>Danger Zone</h2>
        <form
          method="post"
          action={`/admin/users/${user.id}/delete`}
          data-confirm={`Permanently delete user "${user.login}" and all ${projects.length} project(s)? This cannot be undone.`}
        >
          <Button type="submit" label="Delete User" variant="destructive" />
        </form>
      </SectionStack>
    </Layout>
  );
}
