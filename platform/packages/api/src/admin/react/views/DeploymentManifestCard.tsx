/** @jsxImportSource react */

import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Table, TableBody, TableCell, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import type { DeployManifest } from '../../../types.ts';
import { AdminCard } from './AdminCard.tsx';
import { CodeBlock } from './CodeBlock.tsx';

export function DeploymentManifestCard({
  manifest,
  manifestJson,
}: {
  manifest: Pick<DeployManifest, 'bindings' | 'migrations' | 'schedules'>;
  manifestJson: string;
}) {
  return (
    <AdminCard title="Manifest">
      <Table>
        <TableBody>
          {manifest.bindings &&
            Object.entries(manifest.bindings).map(([type, value]) =>
              Array.isArray(value) && value.length > 0 ? (
                <TableRow key={type}>
                  <TableHeaderCell>{type.toUpperCase()}</TableHeaderCell>
                  <TableCell>
                    {value.map((name: string, index: number) => (
                      <span key={name}>
                        {index > 0 && ', '}
                        <code>{name}</code>
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              ) : value === true ? (
                <TableRow key={type}>
                  <TableHeaderCell>{type.toUpperCase()}</TableHeaderCell>
                  <TableCell>enabled</TableCell>
                </TableRow>
              ) : null,
            )}
          {manifest.migrations && (
            <TableRow>
              <TableHeaderCell>Migrations</TableHeaderCell>
              <TableCell>
                {manifest.migrations.dialect} — {manifest.migrations.pending} pending
              </TableCell>
            </TableRow>
          )}
          {manifest.schedules && manifest.schedules.length > 0 && (
            <TableRow>
              <TableHeaderCell>Schedules</TableHeaderCell>
              <TableCell>
                {manifest.schedules.map((schedule, index) => (
                  <span key={schedule.name}>
                    {index > 0 && ', '}
                    {schedule.name}: {schedule.cron}
                  </span>
                ))}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <Collapsible
        className="void-admin-disclosure"
        trigger="Raw JSON"
        chevronPosition="start"
        defaultIsOpen={false}
      >
        <CodeBlock code={manifestJson} language="json" />
      </Collapsible>
    </AdminCard>
  );
}
