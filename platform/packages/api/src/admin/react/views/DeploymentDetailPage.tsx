/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Button } from '@astryxdesign/core/Button';
import { Table, TableBody, TableCell, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import { useRequest, useView } from 'react-fate';
import type { DeployManifest } from '../../../types.ts';
import { DeploymentDetailView, deploymentDetailRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { CopyButton } from './CopyButton.tsx';
import { DeploymentLogs } from './DeploymentLogs.tsx';
import { DeploymentManifestCard } from './DeploymentManifestCard.tsx';
import { displayStatus } from './DeploymentTable.tsx';
import { formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';
import { SectionStack } from './SectionStack.tsx';

export function DeploymentDetailPage({ path, platformName, username }: AdminPageProps) {
  const { deploymentDetail: ref } = useRequest(deploymentDetailRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(DeploymentDetailView, ref);
  if (!pageData) {
    throw new Error('Deployment data is unavailable.');
  }
  const { deployment, project, canCancel, tz } = pageData;
  const manifest = pageData.manifest as DeployManifest | null;
  const status = displayStatus(deployment, project?.active_deployment_id);
  const statusStyle =
    status === 'live'
      ? { color: '#16a34a', fontWeight: 600 }
      : status === 'retained'
        ? { color: '#16a34a' }
        : status === 'evicted'
          ? { color: '#888' }
          : status === 'failed'
            ? { color: '#dc2626' }
            : undefined;
  return (
    <Layout platformName={platformName} title={`Deployment ${deployment.id}`} username={username}>
      <h1>Deployment {deployment.id}</h1>

      {canCancel && (
        <SectionStack>
          <h2>Deploy Control</h2>
          <form
            method="post"
            action={`/admin/deployments/${deployment.id}/cancel`}
            data-confirm={`Cancel deployment "${deployment.id}"?`}
          >
            <Button type="submit" label="Cancel Deploy" variant="destructive" />
          </form>
        </SectionStack>
      )}

      {(deployment.status === 'failed' || deployment.status === 'canceled') &&
        deployment.error_message && (
          <SectionStack>
            <h2>Error</h2>
            <pre>{deployment.error_message}</pre>
            <p>
              <CopyButton text={deployment.error_message} label="Copy error" />
            </p>
          </SectionStack>
        )}

      <Table className="void-admin-detail-table">
        <TableBody>
          <TableRow>
            <TableHeaderCell>ID</TableHeaderCell>
            <TableCell>{deployment.id}</TableCell>
            <TableHeaderCell>Project</TableHeaderCell>
            <TableCell>
              {project ? (
                <a className="void-admin-resource-link" href={`/admin/projects/${project.id}`}>
                  {project.slug}
                </a>
              ) : (
                deployment.project_id
              )}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableCell style={statusStyle}>{status}</TableCell>
            <TableHeaderCell>Source</TableHeaderCell>
            <TableCell>{deployment.source ?? '-'}</TableCell>
          </TableRow>
          <TableRow>
            <TableHeaderCell>Commit</TableHeaderCell>
            <TableCell>{deployment.commit ?? '-'}</TableCell>
            <TableHeaderCell>Created</TableHeaderCell>
            <TableCell>{formatDateTime(deployment.created_at, tz)}</TableCell>
          </TableRow>
          <TableRow>
            <TableHeaderCell>Deployed</TableHeaderCell>
            <TableCell>
              {deployment.deployed_at ? formatDateTime(deployment.deployed_at, tz) : '-'}
            </TableCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableCell>{project?.type ?? '-'}</TableCell>
          </TableRow>
          <TableRow>
            <TableHeaderCell>CLI Version</TableHeaderCell>
            <TableCell>{deployment.cli_version ?? '-'}</TableCell>
            <TableHeaderCell />
            <TableCell />
          </TableRow>
        </TableBody>
      </Table>

      {manifest && <DeploymentManifestCard manifest={manifest} />}

      {deployment.status === 'live' && project && <DeploymentLogs deploymentId={deployment.id} />}
    </Layout>
  );
}
