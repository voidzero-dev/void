import { randomBytes } from 'node:crypto';
import {
  createPlatformInstallationManifest,
  recordInstallationStep,
  transitionInstallation,
} from '@void/platform';
import type { PlatformInstallationManifest } from '@void/platform';
import type { PlatformInstallPlan } from './platform-plan.ts';
import { writeInstallationManifest, writePendingInstallationSecrets } from './platform-registry.ts';

const STARTED = 'credential-setup:v1';
const COMPLETED = 'credential-setup-complete:v1';

/** Includes interrupted provisioning, but not maintenance of an already deployed platform. */
export function isPlatformInstallInProgress(manifest: PlatformInstallationManifest): boolean {
  return (
    manifest.runtime === null &&
    manifest.desiredState === 'enabled' &&
    !manifest.resources.some((resource) => resource.state === 'deleted') &&
    [
      'planned',
      'provisioning',
      'waiting-for-dns',
      'waiting-for-oauth',
      'deploying',
      'verifying',
      'failed',
    ].includes(manifest.status)
  );
}

export function isPlatformSetupDraft(manifest: PlatformInstallationManifest): boolean {
  return (
    manifest.status === 'planned' &&
    manifest.resources.length === 0 &&
    manifest.endpoints.apiUrl === null &&
    manifest.steps.some((step) => step.key === STARTED) &&
    !manifest.steps.some((step) => step.key === COMPLETED)
  );
}

export function savePlatformSetupDraft(
  plan: PlatformInstallPlan,
  version: string,
): PlatformInstallationManifest {
  const now = new Date().toISOString();
  let manifest = createPlatformInstallationManifest({
    account: plan.account,
    deployment: plan.deployment,
    id: plan.installationId,
    createdAt: now,
    platformVersion: version,
    ownershipNonce: randomBytes(32).toString('base64url'),
  });
  manifest = transitionInstallation(manifest, 'planned', now);
  manifest = recordInstallationStep(
    manifest,
    { key: STARTED, completedAt: now, resultHash: plan.installationId },
    now,
  );
  writeInstallationManifest(manifest);
  // Establish secure storage before collecting any secret.
  writePendingInstallationSecrets(
    manifest,
    plan.externalHyperdrive
      ? { externalHyperdriveJson: JSON.stringify(plan.externalHyperdrive) }
      : {},
  );
  return manifest;
}

export function completePlatformSetupDraft(
  manifest: PlatformInstallationManifest,
): PlatformInstallationManifest {
  const now = new Date().toISOString();
  const completed = recordInstallationStep(
    manifest,
    { key: COMPLETED, completedAt: now, resultHash: manifest.id },
    now,
  );
  writeInstallationManifest(completed);
  return completed;
}
