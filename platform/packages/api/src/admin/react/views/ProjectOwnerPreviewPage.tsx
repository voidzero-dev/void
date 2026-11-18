/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import type { previewOperatorProjectOwner } from '../../../operator/tenant-service.ts';
import { Layout } from './Layout.tsx';
import { SectionStack } from './SectionStack.tsx';
type Preview = Awaited<ReturnType<typeof previewOperatorProjectOwner>>;
function suspensionLabel(owner: { suspended: boolean; suspendedReason: string | null }) {
  return owner.suspended ? `Suspended (${owner.suspendedReason ?? 'unknown reason'})` : 'Active';
}
export function ProjectOwnerPreviewPage({
  result,
  convergenceOnly,
  operationBlocked,
  projectId,
  userId,
  platformName,
  username,
}: {
  result: Preview;
  convergenceOnly: boolean;
  operationBlocked: boolean;
  projectId: string;
  userId: string;
  platformName: string;
  username?: string;
}) {
  return (
    <Layout
      platformName={platformName}
      title={`${convergenceOnly ? 'Converge' : 'Transfer'} ${result.target.slug}`}
      username={username}
    >
      <SectionStack>
        <h1>
          {convergenceOnly ? 'Converge Ownership State' : 'Transfer Ownership'}:{' '}
          {result.target.slug}
        </h1>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Account</TableHeaderCell>
              <TableHeaderCell>User</TableHeaderCell>
              <TableHeaderCell>Plan</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableHeaderCell>Current owner</TableHeaderCell>
              <TableCell>
                {result.currentOwner.login} (<code>{result.currentOwner.id}</code>)
              </TableCell>
              <TableCell>{result.currentOwner.plan}</TableCell>
              <TableCell>{suspensionLabel(result.currentOwner)}</TableCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell>New owner</TableHeaderCell>
              <TableCell>
                {result.newOwner.login} (<code>{result.newOwner.id}</code>)
              </TableCell>
              <TableCell>{result.newOwner.plan}</TableCell>
              <TableCell>{suspensionLabel(result.newOwner)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>

        {convergenceOnly ? (
          <p>
            This project is already owned by the target. This is a convergence-only operation:
            applying it repairs membership, usage-counter, routing, and account metadata without
            changing ownership. The owner's stored project role is{' '}
            <strong>{result.targetPreviousRole ?? 'none'}</strong>. Usage transfer is{' '}
            {result.usageTransfer}.
          </p>
        ) : (
          <p>
            The former owner will become a <strong>{result.formerOwnerRole}</strong>. The target's
            current project role is <strong>{result.targetPreviousRole ?? 'none'}</strong>. Usage
            transfer is {result.usageTransfer}.
          </p>
        )}
      </SectionStack>

      <SectionStack>
        <h2>Operation blockers</h2>
        {result.blockers.length > 0 ? (
          <>
            <ul>
              {result.blockers.map((blocker) => (
                <li key={`${blocker.kind}:${blocker.id}`}>
                  {blocker.kind}: {blocker.id} ({blocker.status})
                </li>
              ))}
            </ul>
            {convergenceOnly && !operationBlocked ? (
              <p>Active work does not block convergence.</p>
            ) : null}
          </>
        ) : (
          <p>None.</p>
        )}
      </SectionStack>

      <SectionStack>
        <h2>Convergence</h2>
        <p>
          {result.counterUpdates.detachUserId ? (
            <>
              Usage counters: detach from <code>{result.counterUpdates.detachUserId}</code>, attach
              to <code>{result.counterUpdates.attachUserId}</code>.
            </>
          ) : (
            <>
              Usage counters: attach or reconcile with{' '}
              <code>{result.counterUpdates.attachUserId}</code>; no former-owner detachment is
              needed.
            </>
          )}
        </p>
        <p>Routing and account entries: {result.routingUpdates.join(', ')}</p>
      </SectionStack>

      <SectionStack>
        <h2>GitHub authorization provenance</h2>
        {result.github ? (
          <p>
            {result.github.repository} installation {result.github.installationId}, authorized by{' '}
            {result.github.authorizedByUserId} ({result.github.executor}).
          </p>
        ) : (
          <p>No GitHub connection.</p>
        )}

        {!operationBlocked ? (
          <form
            method="post"
            action={`/admin/projects/${projectId}/owner`}
            className="void-admin-team-actions"
          >
            <input type="hidden" name="userId" defaultValue={userId} />
            <Button
              type="submit"
              label={convergenceOnly ? 'Apply Convergence' : 'Apply Ownership Transfer'}
              variant="destructive"
            />
            <Button href={`/admin/projects/${projectId}`} label="Cancel" variant="secondary" />
          </form>
        ) : (
          <p>
            {convergenceOnly
              ? 'Project deletion blocks convergence.'
              : 'Resolve or cancel all active work before applying this transfer.'}
          </p>
        )}
      </SectionStack>
    </Layout>
  );
}
