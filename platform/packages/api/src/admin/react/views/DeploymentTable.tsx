/** @jsxImportSource react */

import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { Link } from '@void/react';
import type { CSSProperties } from 'react';
import type { Deployment } from '../../../types.ts';
import { CopyButton } from './CopyButton.tsx';
import { formatDateTime } from './format.ts';

type DeploymentRow = Deployment & {
  project_slug?: string | null;
  active_deployment_id?: string | null;
};

export function displayStatus(
  d: Deployment,
  activeDeploymentId: string | null | undefined,
): string {
  if (d.status === 'failed') {
    return 'failed';
  }
  if (d.status !== 'live') {
    return d.status;
  }
  if (d.id === activeDeploymentId) {
    return 'live';
  }
  if (d.retained) {
    return 'retained';
  }
  return 'evicted';
}

function statusColor(status: string): CSSProperties | undefined {
  switch (status) {
    case 'live':
      return { color: '#16a34a', fontWeight: 600 };
    case 'retained':
      return { color: '#16a34a' };
    case 'evicted':
      return { color: '#888' };
    case 'failed':
    case 'canceled':
      return { color: '#dc2626' };
    case 'canceling':
      return { color: '#ca8a04' };
    default:
      return undefined;
  }
}

export function DeploymentTable({
  deployments,
  activeDeploymentId,
  showProject,
  tz,
}: {
  deployments: ReadonlyArray<DeploymentRow>;
  activeDeploymentId?: string | null;
  showProject?: boolean;
  tz?: string;
}) {
  if (deployments.length === 0) {
    return (
      <p>
        <em>No deployments found.</em>
      </p>
    );
  }
  const columns: Array<TableColumn<DeploymentRow>> = [
    {
      key: 'id',
      header: 'ID',
      width: proportional(1, { minWidth: 115 }),
      renderCell: (d: DeploymentRow) => (
        <Link
          className="void-admin-resource-link void-admin-deployment-link"
          href={`/admin/deployments/${d.id}`}
          title={d.id}
        >
          {d.id}
        </Link>
      ),
    },
  ];
  if (showProject) {
    columns.push({
      key: 'project_slug',
      header: 'Project',
      width: proportional(1, { minWidth: 115 }),
      renderCell: (d: DeploymentRow) =>
        d.project_slug ? (
          <Link
            className="void-admin-resource-link void-admin-deployment-link"
            href={`/admin/projects/${d.project_id}`}
            title={d.project_slug}
          >
            {d.project_slug}
          </Link>
        ) : (
          '-'
        ),
    });
  }
  columns.push(
    {
      key: 'status',
      header: 'Status',
      width: pixel(88),
      renderCell: (d: DeploymentRow) => {
        const status = displayStatus(d, activeDeploymentId ?? d.active_deployment_id);
        return <span style={statusColor(status)}>{status}</span>;
      },
    },
    {
      key: 'source',
      header: 'Source',
      width: pixel(84),
      renderCell: (d: DeploymentRow) => d.source ?? '-',
    },
    {
      key: 'cli_version',
      header: 'CLI',
      width: pixel(64),
      renderCell: (d: DeploymentRow) => d.cli_version ?? '-',
    },
    {
      key: 'commit',
      header: 'Commit',
      width: pixel(90),
      renderCell: (d: DeploymentRow) => d.commit?.slice(0, 7) ?? '-',
    },
    {
      key: 'error_message',
      header: 'Error',
      width: proportional(1.8, { minWidth: 180 }),
      renderCell: (d: DeploymentRow) =>
        d.error_message ? (
          <div className="void-admin-deployment-error">
            <Text className="void-admin-deployment-error-message" maxLines={1}>
              {d.error_message}
            </Text>
            <CopyButton text={d.error_message} />
          </div>
        ) : (
          '-'
        ),
    },
    {
      key: 'created_at',
      header: 'Created',
      width: pixel(200),
      renderCell: (d: DeploymentRow) => formatDateTime(d.created_at, tz),
    },
  );
  return (
    <Table
      className="void-admin-deployments-table"
      data={[...deployments]}
      columns={columns}
      textOverflow="truncate"
      hasHover
    />
  );
}
