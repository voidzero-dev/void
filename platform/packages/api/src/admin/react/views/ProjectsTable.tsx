/** @jsxImportSource react */

import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Link } from '@void/react';
import type { Project } from '../../../types.ts';
import { formatDateTime } from './format.ts';
import { ProjectUrlLink } from './ProjectUrlLink.tsx';

export type ProjectRow = Project & {
  url?: string;
  owner_login: string | null;
  last_deploy: string | null;
  last_deploy_id: string | null;
  last_deploy_status: string | null;
};

export function ProjectsTable({
  projects,
  siteDomain,
  tz,
}: {
  projects: ReadonlyArray<ProjectRow>;
  siteDomain: string;
  tz?: string;
}) {
  return (
    <>
      <Table className="void-admin-projects-table" hasHover>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>URL</TableHeaderCell>
            <TableHeaderCell>Owner</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Created</TableHeaderCell>
            <TableHeaderCell>Last Deploy</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <Link className="void-admin-resource-link" href={`/admin/projects/${p.id}`}>
                  {p.slug}
                </Link>
              </TableCell>
              <TableCell>
                <ProjectUrlLink url={p.url ?? `https://${p.slug}.${siteDomain}`} />
              </TableCell>
              <TableCell>
                {p.owner_login ? (
                  <Link className="void-admin-resource-link" href={`/admin/users/${p.user_id}`}>
                    {p.owner_login}
                  </Link>
                ) : (
                  '-'
                )}
              </TableCell>
              <TableCell>{p.type}</TableCell>
              <TableCell>{formatDateTime(p.created_at, tz)}</TableCell>
              <TableCell>
                {p.last_deploy ? (
                  <>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        marginRight: 10,
                        verticalAlign: 'middle',
                        background: p.last_deploy_status === 'failed' ? '#dc2626' : '#16a34a',
                      }}
                    />
                    {p.last_deploy_id ? (
                      <Link href={`/admin/deployments/${p.last_deploy_id}`}>
                        {formatDateTime(p.last_deploy, tz)}
                      </Link>
                    ) : (
                      formatDateTime(p.last_deploy, tz)
                    )}
                  </>
                ) : (
                  '-'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {projects.length === 0 && (
        <p>
          <em>No projects found.</em>
        </p>
      )}
    </>
  );
}
