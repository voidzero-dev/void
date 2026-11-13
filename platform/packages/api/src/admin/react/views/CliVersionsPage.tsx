/** @jsxImportSource react */

import { Table, pixel, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { useRequest, useView } from 'react-fate';
import type { CliVersionDeploymentStats } from '../../../db.ts';
import { CliVersionsView, cliVersionsRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { formatDateTime, formatNumber } from './format.ts';
import { Layout } from './Layout.tsx';
import { SectionStack } from './SectionStack.tsx';

function CliVersionTable({
  rows,
  title,
  tz,
}: {
  rows: ReadonlyArray<CliVersionDeploymentStats>;
  title: string;
  tz?: string;
}) {
  const columns: Array<TableColumn<CliVersionDeploymentStats>> = [
    {
      key: 'cli_version',
      header: 'Version',
      width: proportional(2, { minWidth: 160 }),
      renderCell: (row: CliVersionDeploymentStats) => (
        <Text maxLines={1}>{row.cli_version ?? 'unknown'}</Text>
      ),
    },
    {
      key: 'deployments',
      header: 'Deploys',
      width: proportional(1, { minWidth: 96 }),
      renderCell: (row: CliVersionDeploymentStats) => formatNumber(row.deployments),
    },
    {
      key: 'projects',
      header: 'Projects',
      width: proportional(1, { minWidth: 96 }),
      renderCell: (row: CliVersionDeploymentStats) => formatNumber(row.projects),
    },
    {
      key: 'users',
      header: 'Users',
      width: proportional(1, { minWidth: 96 }),
      renderCell: (row: CliVersionDeploymentStats) => formatNumber(row.users),
    },
    {
      key: 'first_seen',
      header: 'First Seen',
      width: pixel(220),
      renderCell: (row: CliVersionDeploymentStats) => formatDateTime(row.first_seen, tz),
    },
    {
      key: 'last_seen',
      header: 'Last Seen',
      width: pixel(220),
      renderCell: (row: CliVersionDeploymentStats) => formatDateTime(row.last_seen, tz),
    },
  ];
  return (
    <SectionStack>
      <Heading level={2}>{title}</Heading>
      {rows.length === 0 ? (
        <p>
          <em>No deployments found.</em>
        </p>
      ) : (
        <Table
          data={[...rows]}
          columns={columns}
          idKey={(row: CliVersionDeploymentStats) => row.cli_version ?? 'unknown'}
          textOverflow="truncate"
          hasHover
        />
      )}
    </SectionStack>
  );
}

export function CliVersionsPage({ path, platformName, username }: AdminPageProps) {
  const { cliVersions: ref } = useRequest(cliVersionsRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(CliVersionsView, ref);
  if (!pageData) {
    throw new Error('CLI version data is unavailable.');
  }
  const { allTime, last30Days, tz } = pageData;
  return (
    <Layout platformName={platformName} title="CLI Versions" username={username}>
      <Heading level={1}>CLI Versions</Heading>
      <CliVersionTable rows={last30Days} title="Last 30 Days" tz={tz} />
      <CliVersionTable rows={allTime} title="All Time" tz={tz} />
    </Layout>
  );
}
