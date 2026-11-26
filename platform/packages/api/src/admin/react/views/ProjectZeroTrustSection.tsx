/** @jsxImportSource react */

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormTextArea } from './FormControls.tsx';
import { SectionStack } from './SectionStack.tsx';

type PublicGate = Readonly<{
  on: boolean;
  request: Readonly<{ state: string }> | null;
  copy: string | null;
  bypassable: boolean;
  urgentIds: ReadonlyArray<string>;
}>;

type ProjectZeroTrust = Readonly<{
  gate: PublicGate;
  configured: boolean;
  invalid: boolean;
  enabled: boolean;
  status: string | null;
  operation: string | null;
  available: boolean;
  state: Readonly<{
    desired_protected: boolean;
    effective_protected: boolean;
    state: string;
    last_error: string | null;
  }> | null;
}>;

const REVIEW = '/admin/zero-trust';

function protection(value: boolean | undefined): string {
  return value === undefined ? 'not initialized' : value ? 'protected' : 'public';
}

function statusLabel(status: string): string {
  return status === 'error' ? 'needs attention' : status;
}

function platformLabel(zeroTrust: ProjectZeroTrust): string {
  if (zeroTrust.invalid) {
    return 'invalid configuration';
  }
  if (!zeroTrust.configured) {
    return 'not configured';
  }
  const enabled = zeroTrust.enabled ? 'enabled' : 'disabled';
  return zeroTrust.status && zeroTrust.status !== 'ready'
    ? `${enabled}, ${statusLabel(zeroTrust.status)}`
    : enabled;
}

function unavailableReason(zeroTrust: ProjectZeroTrust) {
  if (zeroTrust.invalid) {
    return 'The saved Zero Trust configuration is invalid.';
  }
  if (!zeroTrust.configured || (!zeroTrust.enabled && !zeroTrust.operation)) {
    return 'Project Zero Trust is not enabled.';
  }
  if (zeroTrust.operation) {
    return `A Zero Trust ${zeroTrust.operation} operation is running. Project changes are available after it finishes.`;
  }
  return `Platform Zero Trust status: ${zeroTrust.status ? statusLabel(zeroTrust.status) : 'not ready'}.`;
}

export function ProjectZeroTrustSection({
  projectId,
  zeroTrust,
}: {
  projectId: string;
  zeroTrust: ProjectZeroTrust;
}) {
  const { state, gate } = zeroTrust;
  return (
    <SectionStack id="zero-trust" className="void-admin-project-zero-trust">
      <h2>Zero Trust</h2>
      <div className="void-admin-project-zero-trust-state">
        <span>Platform: {platformLabel(zeroTrust)}</span>
        {(state !== null || zeroTrust.enabled) && (
          <>
            <span>Desired: {protection(state?.desired_protected)}</span>
            <span>Effective: {protection(state?.effective_protected)}</span>
            <Badge
              label={state?.state ?? 'not initialized'}
              variant={
                state?.state === 'error'
                  ? 'error'
                  : state?.state === 'reconciling'
                    ? 'info'
                    : state?.state === 'protected'
                      ? 'success'
                      : 'neutral'
              }
            />
          </>
        )}
      </div>
      {state?.last_error && (
        <Banner status="error" title="Last error" description={state.last_error} />
      )}
      {gate.request && (
        <SectionStack as="div" className="void-admin-security-request">
          <Banner
            status="info"
            title="Public request"
            description={gate.copy ?? gate.request.state}
          />
          {gate.request.state === 'held_findings' && (
            <p>
              Resolve the urgent findings first ({gate.urgentIds.join(', ')}), then the request
              unlocks. <a href="#security">Open the Security section</a>.
            </p>
          )}
        </SectionStack>
      )}
      {zeroTrust.available ? (
        <div className="void-admin-team-actions">
          {gate.request ? (
            <form method="post" action={`/admin/projects/${projectId}/zero-trust`}>
              <input type="hidden" name="protected" value="true" />
              <Button type="submit" label="Cancel request" variant="secondary" />
            </form>
          ) : (
            <form
              method="post"
              action={`/admin/projects/${projectId}/zero-trust`}
              {...(state?.desired_protected
                ? {
                    'data-confirm': gate.on
                      ? 'Make this project public? It stays protected until a security scan of the live deployment finds nothing urgent.'
                      : 'Make this project public? Anyone can reach its hostnames without signing in.',
                  }
                : {})}
            >
              <input
                type="hidden"
                name="protected"
                value={state?.desired_protected ? 'false' : 'true'}
              />
              <Button
                type="submit"
                label={state?.desired_protected ? 'Make project public' : 'Protect project'}
                variant={state?.desired_protected ? 'destructive' : 'primary'}
              />
            </form>
          )}
          <form method="post" action={`/admin/projects/${projectId}/zero-trust/reconcile`}>
            <Button type="submit" label="Reconcile" variant="secondary" />
          </form>
        </div>
      ) : (
        <SectionStack as="div">
          <p>{unavailableReason(zeroTrust)}</p>
          <Button
            href={REVIEW}
            label={
              zeroTrust.operation
                ? 'View status'
                : !zeroTrust.configured || !zeroTrust.enabled
                  ? 'Configure Zero Trust'
                  : 'Review configuration'
            }
            variant="secondary"
            size="sm"
          />
        </SectionStack>
      )}
      {gate.request && gate.bypassable && zeroTrust.available && (
        <SectionStack
          as="form"
          method="post"
          action={`/admin/projects/${projectId}/security/bypass`}
          data-confirm="Bypass the scan? The project goes public without a clean security scan and without a check that fixed findings are really fixed. Every installation admin is told, and the reason is kept on record."
        >
          <FormTextArea label="Reason for bypassing the scan" name="reason" required width={420} />
          <Button type="submit" label="Bypass scan" variant="destructive" />
        </SectionStack>
      )}
    </SectionStack>
  );
}
