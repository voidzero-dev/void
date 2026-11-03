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
import { ProjectDetailView, projectDetailRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { BuildTable } from './BuildTable.tsx';
import { DeploymentTable } from './DeploymentTable.tsx';
import { formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';
import { ProjectOwnerTransferSection } from './ProjectOwnerTransferSection.tsx';
import { ProjectTeamSection } from './ProjectTeamSection.tsx';
import { ProjectUrlLink } from './ProjectUrlLink.tsx';
import { ProjectZeroTrustSection } from './ProjectZeroTrustSection.tsx';
import { SectionStack } from './SectionStack.tsx';
export function ProjectDetailPage({ path, platformName, username }: AdminPageProps) {
  const { projectDetail: ref } = useRequest(projectDetailRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(ProjectDetailView, ref);
  if (!pageData) {
    throw new Error('Project data is unavailable.');
  }
  const {
    project,
    deployments,
    resources,
    owner,
    teamMembers,
    pendingTeamInvitations,
    domains,
    builds,
    zeroTrust,
    cfAccountId,
    deployUrl,
    tz,
  } = pageData;
  return (
    <Layout platformName={platformName} title={project.slug} username={username}>
      <SectionStack>
        <h1>{project.slug}</h1>

        <Table className="void-admin-detail-table">
          <TableBody>
            <TableRow>
              <TableHeaderCell>ID</TableHeaderCell>
              <TableCell>{project.id}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableCell>{project.slug}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>URL</TableHeaderCell>
              <TableCell>
                <ProjectUrlLink url={deployUrl} />
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Custom Domain</TableHeaderCell>
              <TableCell>
                {domains.length > 0 ? (
                  domains.map((d) => (
                    <span key={d.id}>
                      <ProjectUrlLink url={`https://${d.hostname}`} /> ({d.status}){' '}
                    </span>
                  ))
                ) : (
                  <>—</>
                )}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Owner</TableHeaderCell>
              <TableCell>
                {owner ? (
                  <a className="void-admin-resource-link" href={`/admin/users/${owner.id}`}>
                    {owner.login}
                  </a>
                ) : (
                  project.user_id
                )}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableCell>{project.type}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Email</TableHeaderCell>
              <TableCell>
                <a className="void-admin-resource-link" href={`/admin/email/${project.id}`}>
                  usage, limits, destinations
                </a>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableCell>{formatDateTime(project.created_at, tz)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </SectionStack>

      <SectionStack>
        <h2>Resources ({resources.length})</h2>
        {resources.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Binding</TableHeaderCell>
                <TableHeaderCell>CF ID</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resources.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.type}</TableCell>
                  <TableCell>{r.binding_name}</TableCell>
                  <TableCell>
                    {cfAccountId && (r.type === 'd1' || r.type === 'kv' || r.type === 'r2') ? (
                      <a
                        href={
                          r.type === 'd1'
                            ? `https://dash.cloudflare.com/${cfAccountId}/workers/d1/databases/${r.cf_id}/metrics`
                            : r.type === 'kv'
                              ? `https://dash.cloudflare.com/${cfAccountId}/workers/kv/namespaces/${r.cf_id}/metrics`
                              : `https://dash.cloudflare.com/${cfAccountId}/r2/default/buckets/${r.cf_id}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {r.cf_id}
                      </a>
                    ) : (
                      r.cf_id
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p>
            <em>No resources provisioned.</em>
          </p>
        )}
      </SectionStack>

      <SectionStack>
        <h2>Recent Deployments ({deployments.length})</h2>
        <DeploymentTable
          deployments={deployments}
          activeDeploymentId={project.active_deployment_id}
          tz={tz}
        />
      </SectionStack>

      <SectionStack>
        <h2>Builds ({builds.length})</h2>
        <BuildTable builds={builds} tz={tz} />
      </SectionStack>

      <ProjectZeroTrustSection projectId={project.id} zeroTrust={zeroTrust} />

      <ProjectTeamSection
        projectId={project.id}
        owner={owner}
        members={teamMembers}
        invitations={pendingTeamInvitations}
        tz={tz}
      />

      <ProjectOwnerTransferSection projectId={project.id} />

      <SectionStack>
        <h2>Danger Zone</h2>
        <form
          method="post"
          action={`/admin/projects/${project.id}/delete`}
          data-confirm={`Permanently delete project "${project.slug}" and all its resources? This cannot be undone.`}
        >
          <Button type="submit" label="Delete Project" variant="destructive" />
        </form>
      </SectionStack>
    </Layout>
  );
}
