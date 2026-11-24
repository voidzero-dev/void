import { createHash } from 'node:crypto';
import { PLATFORM_HEALTH_HOSTNAME_LABEL, parsePlatformAppAccessSetup } from '@void/platform';
import type { PlatformInstallationManifest } from '@void/platform';
import {
  PlatformAccessClient,
  platformAccessCreateRejected,
  platformAccessPublicDestinations,
} from './platform-access-provision.ts';
import type { PlatformAccessCheckpoint } from './platform-access-provision.ts';
import { parsePlatformAccessSetupSpec } from './platform-access-setup.ts';
import { PlatformCloudflareClient } from './platform-cloudflare.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

/** These reserved endpoints require Void's probe token and cannot serve application traffic. */
export function platformAccessHealthTargets(
  plan: PlatformInstallPlan,
): ReadonlyArray<{ key: string; destination: string }> {
  const dispatch = plan.deployment.application.zoneName
    ? `${PLATFORM_HEALTH_HOSTNAME_LABEL}.${plan.deployment.application.baseDomain}`
    : `${plan.deployment.resources.dispatchWorker}.${plan.workersSubdomain}.workers.dev`;
  const destination = `${dispatch}/health`;
  return [
    {
      key: `health-dispatch-${createHash('sha256').update(destination).digest('hex').slice(0, 12)}`,
      destination,
    },
  ];
}

async function verifyHealthException(
  access: PlatformAccessClient,
  app: Record<string, unknown>,
  destination: string,
): Promise<void> {
  const destinations = platformAccessPublicDestinations(app);
  if (
    typeof app.id !== 'string' ||
    !app.id ||
    app.type !== 'self_hosted' ||
    app.domain !== destination ||
    !destinations.length ||
    destinations.some((value) => value !== destination) ||
    (app.destinations !== undefined &&
      (!Array.isArray(app.destinations) ||
        app.destinations.some(
          (value: { type?: unknown; uri?: unknown }) =>
            !value || value.type !== 'public' || value.uri !== destination,
        ))) ||
    (app.target_criteria !== null &&
      app.target_criteria !== undefined &&
      (!Array.isArray(app.target_criteria) || app.target_criteria.length > 0))
  ) {
    throw new Error(`platform: The Access health exception must cover only ${destination}.`);
  }
  const policies = await access.list(`apps/${encodeURIComponent(app.id)}/policies`);
  const policy = policies[0];
  if (
    policies.length !== 1 ||
    policy?.decision !== 'bypass' ||
    JSON.stringify(policy.include) !== '[{"everyone":{}}]' ||
    (policy.require !== undefined &&
      (!Array.isArray(policy.require) || policy.require.length > 0)) ||
    (policy.exclude !== undefined && (!Array.isArray(policy.exclude) || policy.exclude.length > 0))
  ) {
    throw new Error(
      `platform: The Access policy for ${destination} does not match the reserved health-check exception.`,
    );
  }
}

/** Keep the same path-only exception used by project Zero Trust available during bootstrap. */
export async function ensurePlatformAccessHealthChecks(input: {
  plan: PlatformInstallPlan;
  manifest: PlatformInstallationManifest;
  client: Partial<Pick<PlatformCloudflareClient, 'request' | 'apiBaseUrl'>>;
  checkpoint: Readonly<Record<string, string>>;
  save: (encoded: string) => void;
}): Promise<void> {
  // The server owns ongoing app access after setup. Its token may have been
  // rotated or its settings changed by an administrator since installation.
  const appAccess =
    !input.manifest.steps.some((step) => step.key === 'app-access-initialized:v1') &&
    input.checkpoint.appAccessSetupJson
      ? parsePlatformAppAccessSetup(JSON.parse(input.checkpoint.appAccessSetupJson))
      : null;
  if (appAccess && appAccess.accountId !== input.plan.account.id) {
    throw new Error('platform: App access recovery belongs to another Cloudflare account.');
  }
  if (!input.plan.deployment.authentication.accessProtection && !appAccess?.managed) {
    return;
  }
  const spec = appAccess?.managed
    ? { mode: 'create' as const, accountId: input.plan.account.id }
    : parsePlatformAccessSetupSpec(JSON.parse(input.checkpoint.accessSetupSpecJson || 'null'));
  const accountId = input.plan.account.id;
  const identityAccountId = spec.accountId ?? accountId;
  const token = appAccess?.managed
    ? appAccess.apiToken
    : identityAccountId === accountId
      ? process.env.VOID_PLATFORM_ACCESS_SETUP_TOKEN || input.checkpoint.accessManagementToken
      : undefined;
  if (!token && !input.client.request) {
    throw new Error(
      'platform: Access management is required to configure the reserved health endpoints.',
    );
  }
  const access = new PlatformAccessClient(
    token
      ? new PlatformCloudflareClient(token, { apiBase: input.client.apiBaseUrl })
      : { request: input.client.request!.bind(input.client) },
    accountId,
  );
  const nonce = createHash('sha256')
    .update(`void-access-health:${input.manifest.ownershipNonce}`)
    .digest('hex')
    .slice(0, 32);
  const state: PlatformAccessCheckpoint = input.checkpoint.accessHealthProvisioningJson
    ? JSON.parse(input.checkpoint.accessHealthProvisioningJson)
    : { version: 1, accountId, installationId: input.manifest.id, nonce, resources: {} };
  if (
    !state ||
    state.version !== 1 ||
    state.accountId !== accountId ||
    input.manifest.account.id !== accountId ||
    state.installationId !== input.manifest.id ||
    state.installationId !== input.plan.installationId ||
    state.nonce !== nonce ||
    !state.resources ||
    typeof state.resources !== 'object' ||
    Array.isArray(state.resources)
  ) {
    throw new Error('platform: Access health recovery data belongs to a different installation.');
  }
  const save = () => input.save(JSON.stringify(state));
  const inventory = await access.list('apps');
  for (const { key, destination } of platformAccessHealthTargets(input.plan)) {
    const expected = {
      type: 'self_hosted',
      domain: destination,
      destinations: [{ type: 'public', uri: destination }],
      policies: [
        {
          name: 'Void platform health check',
          decision: 'bypass',
          precedence: 1,
          include: [{ everyone: {} }],
        },
      ],
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
    let recorded = state.resources[key];
    const name = `void-${input.manifest.id}-${key}`.slice(0, 90) + '-' + nonce.slice(0, 16);
    if (
      recorded &&
      (recorded.name !== name || recorded.fingerprint !== fingerprint || recorded.adopted)
    ) {
      throw new Error('platform: The recorded Access health exception changed identity or scope.');
    }
    const matching = inventory.filter((app) =>
      platformAccessPublicDestinations(app).includes(destination),
    );
    if (matching.length > 1 || (recorded?.id && matching.some((app) => app.id !== recorded.id))) {
      throw new Error(
        `platform: Multiple Access applications cover ${destination}. Reconcile them before resuming.`,
      );
    }
    // A manually configured or project-managed exact exception is verified without taking ownership.
    if (!recorded && matching.length === 1) {
      await verifyHealthException(access, matching[0]!, destination);
      continue;
    }
    if (!recorded?.id && recorded?.pending) {
      const candidates = inventory.filter((app) => app.name === name);
      if (candidates.length !== 1 || typeof candidates[0]?.id !== 'string') {
        throw new Error(
          'platform: Access health application creation has an uncertain outcome. Inspect Cloudflare before retrying; no duplicate was created.',
        );
      }
      recorded.id = candidates[0].id;
      save();
    }
    if (!recorded?.id) {
      if (spec.mode !== 'create') {
        throw new Error(
          `platform: Configure an Access exception limited to ${destination}, then resume. Void's private probe token still protects this endpoint.`,
        );
      }
      if (inventory.some((app) => app.name === name)) {
        throw new Error(
          'platform: An Access health application with this installation identity already exists. Inspect it before resuming.',
        );
      }
      recorded = { name, fingerprint, pending: true };
      state.resources[key] = recorded;
      save();
      try {
        const created = (await access.create('apps', { ...expected, name })) as Record<
          string,
          unknown
        >;
        if (!created || typeof created.id !== 'string' || !created.id) {
          throw new Error('platform: Cloudflare did not return the Access health application ID.');
        }
        recorded.id = created.id;
        save();
      } catch (error) {
        if (platformAccessCreateRejected(error)) {
          recorded.pending = false;
          save();
        }
        throw error;
      }
    }
    const app = (await access.get(`apps/${encodeURIComponent(recorded.id!)}`)) as Record<
      string,
      unknown
    >;
    if (!app || app.id !== recorded.id || app.name !== recorded.name) {
      throw new Error('platform: The Access health application changed ownership identity.');
    }
    await verifyHealthException(access, app, destination);
    recorded.pending = false;
    save();
  }
}
