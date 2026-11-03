/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Button } from '@astryxdesign/core/Button';
import { Table, TableBody, TableCell, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import { useRequest, useView } from 'react-fate';
import { BuildDetailView, buildDetailRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { BuildLogs } from './BuildLogs.tsx';
import { formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';
import { SectionStack } from './SectionStack.tsx';

export function BuildDetailPage({ path, platformName, username }: AdminPageProps) {
  const { buildDetail: ref } = useRequest(buildDetailRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(BuildDetailView, ref);
  if (!pageData) {
    throw new Error('Build data is unavailable.');
  }
  const { build, tz } = pageData;
  return (
    <Layout platformName={platformName} title={`Build ${build.id}`} username={username}>
      <SectionStack>
        <h1>Build {build.id}</h1>

        <Table className="void-admin-detail-table">
          <TableBody>
            <TableRow>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableCell>{build.status}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Project</TableHeaderCell>
              <TableCell>
                <a
                  className="void-admin-resource-link"
                  href={`/admin/projects/${build.project_id}`}
                >
                  {build.project_id}
                </a>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Executor</TableHeaderCell>
              <TableCell>{build.executor}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Instance Type</TableHeaderCell>
              <TableCell>{build.instance_type ?? '-'}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Commit</TableHeaderCell>
              <TableCell>{build.commit_sha ? build.commit_sha.slice(0, 7) : '-'}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Branch</TableHeaderCell>
              <TableCell>{build.branch ?? '-'}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Deployment</TableHeaderCell>
              <TableCell>
                {build.deployment_id ? (
                  <a
                    className="void-admin-resource-link"
                    href={`/admin/deployments/${build.deployment_id}`}
                  >
                    {build.deployment_id}
                  </a>
                ) : (
                  '-'
                )}
              </TableCell>
            </TableRow>
            {build.error ? (
              <TableRow>
                <TableHeaderCell>Error</TableHeaderCell>
                <TableCell>
                  <span style="color: red; max-width: 600px; display: inline-block; word-break: break-word">
                    {build.error}
                  </span>
                </TableCell>
              </TableRow>
            ) : null}
            <TableRow>
              <TableHeaderCell>Exit Code</TableHeaderCell>
              <TableCell>{build.exit_code ?? '-'}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Started</TableHeaderCell>
              <TableCell>{build.started_at ? formatDateTime(build.started_at, tz) : '-'}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Completed</TableHeaderCell>
              <TableCell>
                {build.completed_at ? formatDateTime(build.completed_at, tz) : '-'}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableCell>{formatDateTime(build.created_at, tz)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </SectionStack>

      {build.executor === 'container' ? (
        <BuildLogs build={build} />
      ) : (
        <SectionStack>
          <h2>Build Logs</h2>
          {build.logs_url ? (
            <Button
              as="a"
              href={build.logs_url}
              target="_blank"
              rel="noopener noreferrer"
              label="View logs on GitHub ↗"
              variant="secondary"
            />
          ) : (
            <p>
              <em>No external logs available.</em>
            </p>
          )}
        </SectionStack>
      )}
    </Layout>
  );
}
