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
import type { CSSProperties } from 'react';
import { ACTIVE_BUILD_STATUSES } from '../../../build-status.ts';
import type { Build } from '../../../types.ts';
import { formatDateTime, parseUtcDate } from './format.ts';

const STATUS_SYMBOL: Record<Build['status'], string> = {
  queued: '○ queued',
  starting: '● starting',
  building: '● building',
  deploying: '● deploying',
  complete: '✓ complete',
  failed: '✗ failed',
  cancelled: '⊘ cancelled',
};

function isActive(status: Build['status']): boolean {
  return (ACTIVE_BUILD_STATUSES as ReadonlyArray<Build['status']>).includes(status);
}

function statusColor(status: Build['status']): CSSProperties | undefined {
  switch (status) {
    case 'complete':
      return { color: '#16a34a', fontWeight: 600 };
    case 'failed':
    case 'cancelled':
      return { color: '#dc2626' };
    case 'starting':
    case 'building':
    case 'deploying':
      return { color: '#ca8a04', fontWeight: 600 };
    default:
      return undefined;
  }
}

function duration(build: Build): string {
  if (!build.started_at) {
    return '-';
  }
  const start = parseUtcDate(build.started_at).getTime();
  const end = build.completed_at ? parseUtcDate(build.completed_at).getTime() : Date.now();
  if (isNaN(start) || isNaN(end) || end < start) {
    return '-';
  }
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function BuildTable({ builds, tz }: { builds: ReadonlyArray<Build>; tz?: string }) {
  if (builds.length === 0) {
    return (
      <p>
        <em>No builds.</em>
      </p>
    );
  }
  return (
    <Table hasHover>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Executor</TableHeaderCell>
          <TableHeaderCell>Instance</TableHeaderCell>
          <TableHeaderCell>Commit</TableHeaderCell>
          <TableHeaderCell>Branch</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell>Duration</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {builds.map((b) => {
          const active = isActive(b.status);
          return (
            <TableRow key={b.id} className={active ? 'build-active' : undefined}>
              <TableCell>
                <Link className="void-admin-resource-link" href={`/admin/builds/${b.id}`}>
                  {b.id}
                </Link>
              </TableCell>
              <TableCell>
                <span style={statusColor(b.status)}>{STATUS_SYMBOL[b.status] ?? b.status}</span>
              </TableCell>
              <TableCell>{b.executor}</TableCell>
              <TableCell>{b.instance_type ?? '-'}</TableCell>
              <TableCell>{b.commit_sha ? b.commit_sha.slice(0, 7) : '-'}</TableCell>
              <TableCell>{b.branch ?? '-'}</TableCell>
              <TableCell>{b.started_at ? formatDateTime(b.started_at, tz) : '-'}</TableCell>
              <TableCell>
                <span suppressHydrationWarning>{duration(b)}</span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
