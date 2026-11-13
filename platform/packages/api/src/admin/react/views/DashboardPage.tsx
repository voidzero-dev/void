/** @jsxImportSource react */

import { Skeleton } from '@astryxdesign/core/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Link } from '@void/react';
import { Suspense, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { useListView, useRequest, useView, type Deferred, type ViewRef } from 'react-fate';
import { DashboardView, dashboardRequest, TopProjectView } from '../../fate/views.ts';
import { AdminCard } from './AdminCard.tsx';
import { DeploymentTable } from './DeploymentTable.tsx';
import { formatDateTime, formatNumber } from './format.ts';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { ProjectsTable } from './ProjectsTable.tsx';
import { ProjectUrlLink } from './ProjectUrlLink.tsx';
import { SystemStatusCard } from './SystemStatusCard.tsx';

const AdminSuspense = Suspense as unknown as (props: {
  children: ReactNode;
  fallback: ReactNode;
}) => ReactElement;
const subscribeToClientRender = () => () => {};
const isClientRender = () => true;
const isServerRender = () => false;

type DashboardProps = Readonly<{
  platformName: string;
  username?: string;
  healthCheckNames: ReadonlyArray<string>;
}>;

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function TopProjectsWidget({
  topProjects,
  siteDomain,
  tz,
}: {
  topProjects: Deferred<{ items: ReadonlyArray<{ node: ViewRef<'AdminTopProject'> }> }>;
  siteDomain: string;
  tz?: string;
}) {
  const [projects] = useListView({ items: { node: TopProjectView } }, topProjects);
  return (
    <AdminCard title="Top Projects by Traffic (last hour)">
      {projects.length > 0 ? (
        <Table className="void-admin-top-projects-table" hasHover>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>#</TableHeaderCell>
              <TableHeaderCell>Project</TableHeaderCell>
              <TableHeaderCell>Owner</TableHeaderCell>
              <TableHeaderCell>Requests</TableHeaderCell>
              <TableHeaderCell>Bandwidth</TableHeaderCell>
              <TableHeaderCell>Last Seen</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map(({ node }, index) => (
              <TopProjectTableRow
                key={node.id}
                projectRef={node}
                index={index}
                siteDomain={siteDomain}
                tz={tz}
              />
            ))}
          </TableBody>
        </Table>
      ) : (
        <Text type="supporting">No recent project traffic in the last hour.</Text>
      )}
    </AdminCard>
  );
}

function TopProjectTableRow({
  projectRef,
  index,
  siteDomain,
  tz,
}: {
  projectRef: ViewRef<'AdminTopProject'>;
  index: number;
  siteDomain: string;
  tz?: string;
}) {
  const project = useView(TopProjectView, projectRef);
  return (
    <TableRow>
      <TableCell>{index + 1}</TableCell>
      <TableCell>
        <div className="void-admin-top-project">
          <div className="void-admin-top-project-heading">
            <Link
              className="void-admin-resource-link void-admin-top-project-name"
              href={`/admin/projects/${project.id}`}
              title={project.slug}
            >
              {project.slug}
            </Link>
            <span className="void-admin-top-project-type">{project.type}</span>
          </div>
          <div className="void-admin-top-project-meta">
            <ProjectUrlLink url={project.url ?? `https://${project.slug}.${siteDomain}`} />
          </div>
        </div>
      </TableCell>
      <TableCell>
        {project.owner_login ? (
          <Link className="void-admin-resource-link" href={`/admin/users/${project.user_id}`}>
            {project.owner_login}
          </Link>
        ) : (
          '-'
        )}
      </TableCell>
      <TableCell>{formatNumber(project.requests)}</TableCell>
      <TableCell>{formatBytes(project.bandwidthBytes)}</TableCell>
      <TableCell>{formatDateTime(project.lastSeen, tz)}</TableCell>
    </TableRow>
  );
}

function DeferredTopProjects({
  topProjects,
  siteDomain,
  tz,
}: {
  topProjects: Deferred<{ items: ReadonlyArray<{ node: ViewRef<'AdminTopProject'> }> }>;
  siteDomain: string;
  tz?: string;
}) {
  const mounted = useSyncExternalStore(subscribeToClientRender, isClientRender, isServerRender);
  const fallback = (
    <AdminCard title="Top Projects by Traffic (last hour)">
      <div className="void-admin-card-loading">
        <Skeleton width="100%" height={48} />
        <Skeleton width="100%" height={48} index={1} />
      </div>
    </AdminCard>
  );
  if (!mounted) {
    return fallback;
  }
  return (
    <AdminSuspense fallback={fallback}>
      <TopProjectsWidget topProjects={topProjects} siteDomain={siteDomain} tz={tz} />
    </AdminSuspense>
  );
}

export function DashboardPage({ platformName, username, healthCheckNames }: DashboardProps) {
  const { dashboard: dashboardRef } = useRequest(dashboardRequest, {
    mode: 'stale-while-revalidate',
  });
  const dashboard = useView(DashboardView, dashboardRef);
  if (!dashboard) {
    throw new Error('Dashboard data is unavailable.');
  }
  return (
    <Layout platformName={platformName} title="Dashboard" username={username}>
      <Heading level={1}>Dashboard</Heading>
      <SystemStatusCard checkNames={healthCheckNames} />
      <div className="void-admin-metrics">
        <AdminCard title="Users" href="/admin/users">
          <Text type="display-3" display="block" hasTabularNumbers>
            {formatNumber(dashboard.userCount)}
          </Text>
        </AdminCard>
        <AdminCard title="Projects" href="/admin/projects">
          <Text type="display-3" display="block" hasTabularNumbers>
            {formatNumber(dashboard.projectCount)}
          </Text>
        </AdminCard>
        <AdminCard title="Deployments" href="/admin/deployments">
          <Text type="display-3" display="block" hasTabularNumbers>
            {formatNumber(dashboard.deploymentCount)}
          </Text>
        </AdminCard>
      </div>
      <PageStack className="void-admin-dashboard-sections">
        <DeferredTopProjects
          topProjects={dashboard.topProjects}
          siteDomain={dashboard.siteDomain}
          tz={dashboard.tz}
        />
        <AdminCard title="Latest Projects">
          <ProjectsTable
            projects={dashboard.projects}
            siteDomain={dashboard.siteDomain}
            tz={dashboard.tz}
          />
        </AdminCard>
        <AdminCard title="Latest Deployments">
          <DeploymentTable deployments={dashboard.deployments} showProject tz={dashboard.tz} />
        </AdminCard>
      </PageStack>
    </Layout>
  );
}
