import { parsePlatformAccessProtection } from '@void/platform';
import type { PlatformAccessProtection, PlatformInstallationManifest } from '@void/platform';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import {
  inspectPlatformAccess,
  PlatformAccessClient,
  platformAccessNonce,
  platformAccessOverlapsOrigins,
  platformAccessPublicDestinations,
  verifyPlatformAccessApplication,
} from './platform-access-provision.ts';
import type { PlatformAccessCheckpoint } from './platform-access-provision.ts';
import {
  parsePlatformAccessSetupSpec,
  platformAccessResourceInventory,
} from './platform-access-setup.ts';
import { PlatformCloudflareClient } from './platform-cloudflare.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

type CloudflareReader = Partial<
  Pick<
    PlatformCloudflareClient,
    'request' | 'apiBaseUrl' | 'listWorkerDomains' | 'listWorkerServiceRoutes'
  >
>;

/** Recheck live protection without invoking any provisioning or configuration write. */
export async function verifyInstalledPlatformAccessProtection(input: {
  client: CloudflareReader;
  manifest: PlatformInstallationManifest;
  plan: Pick<PlatformInstallPlan, 'apiUrl' | 'proxyUrl' | 'actions'>;
  dashboardUrl?: string | null;
  protection: PlatformAccessProtection | null;
  checkpoint: Readonly<Record<string, string>>;
}): Promise<void> {
  const protection = parsePlatformAccessProtection(input.protection);
  if (!protection) {
    return;
  }
  const encoded = input.checkpoint.accessProvisioningJson;
  const specEncoded = input.checkpoint.accessSetupSpecJson;
  if (!encoded || !specEncoded) {
    throw new Error(
      'platform: Restore the current encrypted Access setup checkpoint before maintaining this protected installation.',
    );
  }
  platformAccessResourceInventory(encoded, input.manifest.id);
  const state = JSON.parse(encoded) as PlatformAccessCheckpoint;
  const spec = parsePlatformAccessSetupSpec(JSON.parse(specEncoded));
  if (
    state.accountId !== (spec.accountId ?? input.manifest.account.id) ||
    state.nonce !== platformAccessNonce(input.manifest.ownershipNonce)
  ) {
    throw new Error(
      'platform: The saved Access setup does not match this installation and identity account.',
    );
  }
  const application = state.resources.protection;
  const service = state.resources['service-token'];
  if (
    !application?.id ||
    application.pending ||
    !service?.id ||
    service.pending ||
    (spec.protectionApplicationId && spec.protectionApplicationId !== application.id)
  ) {
    throw new Error(
      'platform: Complete or restore the Access application and service-token checkpoint before maintenance.',
    );
  }
  if (
    !input.client.request ||
    !input.client.listWorkerDomains ||
    !input.client.listWorkerServiceRoutes
  ) {
    throw new Error(
      'platform: Read-only Access and Worker origin verification is required before maintaining protection.',
    );
  }
  const token =
    process.env.VOID_PLATFORM_ACCESS_SETUP_TOKEN || input.checkpoint.accessManagementToken;
  const management = token
    ? new PlatformCloudflareClient(token, { apiBase: input.client.apiBaseUrl })
    : { request: input.client.request.bind(input.client) };
  const access = new PlatformAccessClient(management, state.accountId);
  const policy = {
    identityProviderIds: spec.identityProviderIds ?? [],
    policyIds: spec.policyIds ?? [],
  };
  const inspected = await inspectPlatformAccess(access, policy);
  if (inspected.teamDomain !== protection.teamDomain) {
    throw new Error(
      'platform: The live Access team domain does not match the active platform protection.',
    );
  }
  const app = (await access.get(`apps/${encodeURIComponent(application.id)}`)) as Record<
    string,
    unknown
  >;
  if (!app || app.id !== application.id || app.name !== application.name) {
    throw new Error(
      'platform: The saved Access protection application no longer matches its resource.',
    );
  }
  await verifyPlatformAccessApplication(access, policy, app, 'self_hosted', service.id);
  const origins = protection.applications.map((entry) => entry.origin);
  const requiredOrigins = [
    input.plan.apiUrl,
    input.plan.proxyUrl,
    ...(input.dashboardUrl ? [input.dashboardUrl] : []),
    ...(input.manifest.endpoints.dashboardUrl ? [input.manifest.endpoints.dashboardUrl] : []),
  ].map((value) => new URL(value).origin);
  if (
    requiredOrigins.some((origin) => !origins.includes(origin)) ||
    protection.applications.some(
      (entry) =>
        entry.audience !== app.aud ||
        !platformAccessPublicDestinations(app).includes(new URL(entry.origin).hostname),
    )
  ) {
    throw new Error(
      'platform: Access audiences and complete origin coverage must match the active platform protection. Restore the current Access checkpoint or repair its applications.',
    );
  }
  for (const other of await access.list('apps')) {
    if (other.id === app.id) {
      continue;
    }
    if (platformAccessOverlapsOrigins(other, origins)) {
      throw new Error(
        'platform: Another Access application overlaps a protected platform origin. Reconcile it before maintenance.',
      );
    }
  }
  const liveToken = (await access.list('service_tokens')).find((entry) => entry.id === service.id);
  const expiry = liveToken?.expires_at;
  if (
    !liveToken ||
    liveToken.enabled === false ||
    (typeof expiry === 'string' &&
      (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()))
  ) {
    throw new Error(
      'platform: The platform Access service token is unavailable or expired. Restore its admitted credentials before maintenance.',
    );
  }
  for (const origin of origins) {
    const headers = cfAccessHeaders(
      input.checkpoint.accessCredentialsJson
        ? { VOID_ACCESS_CREDENTIALS: input.checkpoint.accessCredentialsJson }
        : process.env,
      origin,
    );
    if (
      headers['CF-Access-Client-Id'] !== liveToken.client_id ||
      !headers['CF-Access-Client-Secret']
    ) {
      throw new Error(
        'platform: Restore the origin-scoped Access service credentials admitted by the active protection application.',
      );
    }
  }
  const existingWorkers = input.plan.actions
    .filter((action) => action.kind === 'worker' && action.action === 'update')
    .map((action) => action.name);
  if (existingWorkers.length) {
    const { verifyProtectionWorkerOrigins } = await import('./platform-auth-protection.ts');
    await verifyProtectionWorkerOrigins(
      {
        request: input.client.request.bind(input.client),
        listWorkerDomains: input.client.listWorkerDomains.bind(input.client),
        listWorkerServiceRoutes: input.client.listWorkerServiceRoutes.bind(input.client),
      },
      input.manifest,
      origins,
      false,
      { workerNames: existingWorkers },
    );
  }
}
