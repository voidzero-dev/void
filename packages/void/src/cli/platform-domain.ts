import {
  createApplicationRoutes,
  createPlatformDeploymentManifest,
  normalizeApplicationDomain,
  PLATFORM_HEALTH_HOSTNAME_LABEL,
  PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
} from '@void/platform';
import type { PlatformApplication, PlatformInstallationManifest } from '@void/platform';
import { confirm, isCancel, text } from '@voidzero-dev/vite-plus-prompts';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { printSuccess, note } from './output.ts';
import type { PlatformArgs } from './platform-args.ts';
import {
  assertPlatformOperatorCredentialCanApplyPlan,
  platformOperatorCredentialLabel,
  resolvePlatformCloudflareCredential,
} from './platform-auth.ts';
import { PlatformCloudflareClient } from './platform-cloudflare.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  createPlatformHealthProbeToken,
  recordResource,
} from './platform-installer.ts';
import {
  assertNoninteractivePlatformMutationAcknowledged,
  resolvePlatformInstallDatabaseUrl,
} from './platform-lifecycle.ts';
import {
  resolveInstalledPlatformManifest,
  selectAuthoritativePlatformManifest,
  verifyPlatformInstallationOwnership,
} from './platform-management.ts';
import { createPlatformInstallPlan } from './platform-plan.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  readInstallationRecoverySecrets,
  savePlatformConnection,
  writeInstallationManifest,
} from './platform-registry.ts';
import { recordPlatformWorkerTraffic } from './platform-traffic.ts';

type DomainArgs = Extract<PlatformArgs, { subcommand: 'domain' }>;
type DomainResult = Readonly<{
  manifest: PlatformInstallationManifest;
  waitingForDns: boolean;
  waitingForProtection: boolean;
  nameServers: ReadonlyArray<string>;
}>;

export function platformDomainTarget(
  manifest: PlatformInstallationManifest,
  domain: string,
  zone: string,
  dedicatedZone: boolean,
): PlatformApplication {
  const current = manifest.deployment.application;
  if (!current.workersDev) {
    throw new Error('platform: This command adds a domain to a workers.dev test installation.');
  }
  if (!['installed', 'disabled'].includes(manifest.status)) {
    throw new Error(
      'platform: Finish the interrupted platform lifecycle operation before adding a domain.',
    );
  }
  if (current.zoneName && current.baseDomain !== domain) {
    throw new Error(
      `platform: This installation already uses ${current.baseDomain}. Replacing an existing application domain is not supported.`,
    );
  }
  if (
    manifest.pendingDomain &&
    (manifest.pendingDomain.baseDomain !== domain || manifest.pendingDomain.zoneName !== zone)
  ) {
    throw new Error(
      `platform: Finish the pending setup with void platform domain set ${manifest.pendingDomain.baseDomain}.`,
    );
  }
  return createPlatformDeploymentManifest({
    ...manifest.deployment,
    application: {
      baseDomain: domain,
      zoneName: zone,
      dedicatedZone:
        manifest.pendingDomain?.dedicatedZone ??
        (current.zoneName ? current.dedicatedZone : dedicatedZone),
      workersDev: current.workersDev,
      ...(current.zoneId ? { zoneId: current.zoneId } : {}),
    },
  }).application;
}

const now = () => new Date().toISOString();

export async function applyPlatformDomain(
  client: PlatformCloudflareClient,
  original: PlatformInstallationManifest,
  target: PlatformApplication,
  plan: PlatformInstallPlan,
  dependencies: {
    checkpoint: (manifest: PlatformInstallationManifest) => Promise<void>;
    verifyOwnership: (manifest: PlatformInstallationManifest) => Promise<void>;
    verifyRuntimeToken: (zoneId: string) => Promise<void>;
    probe?: (hostname: string, manifest: PlatformInstallationManifest) => Promise<void>;
    activate?: (
      application: PlatformApplication,
      manifest: PlatformInstallationManifest,
    ) => Promise<boolean>;
  },
): Promise<DomainResult> {
  let manifest = original;
  const save = async (next: PlatformInstallationManifest) => {
    await dependencies.checkpoint(next);
    manifest = next;
  };
  await dependencies.verifyOwnership(manifest);
  await save({ ...manifest, pendingDomain: target, updatedAt: now() });
  const zoneAction = plan.actions.find((action) => action.key === 'zone');
  if (!zoneAction) {
    throw new Error('platform: Domain plan has no zone.');
  }
  let zone = plan.zone;
  if (!zone) {
    zone = await client.createZone(manifest.account.id, target.zoneName);
  }
  await save(
    recordResource(
      manifest,
      zoneAction,
      zone.id,
      zoneAction.action === 'create'
        ? 'created'
        : manifest.resources.some((resource) => resource.key === 'zone')
          ? undefined
          : 'adopted',
      now(),
    ),
  );
  if (zone.status !== 'active') {
    return {
      manifest,
      waitingForDns: true,
      waitingForProtection: false,
      nameServers: zone.nameServers,
    };
  }
  await dependencies.verifyRuntimeToken(zone.id);
  const dnsAction = plan.actions.find((action) => action.key === 'application-dns');
  if (!dnsAction) {
    throw new Error('platform: Domain plan has no application DNS record.');
  }
  if (dnsAction.action === 'create') {
    // Re-read immediately before creating; a retry must adopt a record created by an ambiguous response.
    const current = await client.listDnsRecords(zone.id, dnsAction.name);
    if (current.length) {
      throw new Error('platform: DNS changed since the plan. Rerun the command to review it.');
    }
    const dns = await client.createDnsRecord(zone.id, dnsAction.name);
    await save(recordResource(manifest, dnsAction, dns.id, 'created', now()));
  } else {
    if (!dnsAction.id) {
      throw new Error('platform: Domain DNS record has no identity.');
    }
    await save(
      recordResource(
        manifest,
        dnsAction,
        dnsAction.id,
        dnsAction.action === 'adopt' ? 'adopted' : undefined,
        now(),
      ),
    );
  }
  await dependencies.verifyOwnership(manifest);
  const patterns = createApplicationRoutes(target).map((route) => route.pattern);
  await client.publishWorkerRoutesSafely(
    zone.id,
    manifest.deployment.resources.dispatchWorker,
    patterns,
  );
  const routes = await client.listWorkerRoutes(zone.id);
  const deployment = createPlatformDeploymentManifest({
    ...manifest.deployment,
    application: { ...target, zoneId: zone.id },
  });
  const observed = recordPlatformWorkerTraffic(
    { ...manifest, deployment },
    deployment.resources.dispatchWorker,
    { customDomains: [], routes },
    now(),
  );
  await save({ ...manifest, resources: observed.resources, updatedAt: now() });
  // The dispatcher health endpoint works while traffic is disabled and before the domain is canonical.
  // Project Zero Trust leaves only this hostname of the domain outside Access.
  await (dependencies.probe ?? probePlatformDomain)(
    `${PLATFORM_HEALTH_HOSTNAME_LABEL}.${target.baseDomain}`,
    manifest,
  );
  await dependencies.verifyOwnership(manifest);
  // The API publishes the application to routing storage during activation.
  // Stop with a repair hint before that call if the installation record says
  // the storage is not ready.
  const routing = manifest.resources.find(
    (resource) => resource.key === 'routing-kv' && resource.state === 'ready',
  );
  if (!routing) {
    throw new Error('platform: Routing storage is missing. Run platform repair first.');
  }
  const activated = await (dependencies.activate ?? activatePlatformDomain)(
    deployment.application,
    manifest,
  );
  if (!activated) {
    return { manifest, waitingForDns: false, waitingForProtection: true, nameServers: [] };
  }
  const { pendingDomain: _pending, ...ready } = manifest;
  await save({ ...ready, deployment, updatedAt: now() });
  return { manifest, waitingForDns: false, waitingForProtection: false, nameServers: [] };
}

export async function activatePlatformDomain(
  application: PlatformApplication,
  manifest: PlatformInstallationManifest,
): Promise<boolean> {
  const url = `${manifest.endpoints.apiUrl}/internal/platform/domain-activate`;
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Content-Type': 'application/json',
      'X-Void-Platform-Probe': createPlatformHealthProbeToken(manifest.ownershipNonce),
      ...cfAccessHeaders(process.env, url),
    },
    body: JSON.stringify({ application }),
  });
  // A runtime before 0.22.0 has no activation handoff and answers with a
  // non-JSON 404. Platform management commands do not run the minimum
  // platform version check, so keep this.
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    installationId?: string;
    ready?: boolean;
    error?: string;
  } | null;
  if (!body || typeof body !== 'object' || response.status === 404) {
    throw new Error(
      `platform: The running platform cannot activate this domain (HTTP ${response.status}). Update the platform runtime with \`void platform upgrade ${manifest.id}\` (or repair it with \`void platform repair ${manifest.id}\`), then rerun this command.`,
    );
  }
  if (
    !response.ok ||
    body.ok !== true ||
    body.installationId !== manifest.id ||
    typeof body.ready !== 'boolean'
  ) {
    throw new Error(
      `platform: ${body.error ?? 'The running platform could not prepare domain protection. Update or repair the platform, then rerun this command.'}`,
    );
  }
  return body.ready;
}

async function probePlatformDomain(
  hostname: string,
  manifest: PlatformInstallationManifest,
): Promise<void> {
  const url = `https://${hostname}/health`;
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'X-Void-Platform-Probe': createPlatformHealthProbeToken(manifest.ownershipNonce),
        ...cfAccessHeaders(process.env, url),
      },
    });
    const body = (await response.json()) as { ok?: boolean; installationId?: string };
    if (!response.ok || body.ok !== true || body.installationId !== manifest.id) {
      throw new Error('Identity or health did not match.');
    }
  } catch {
    throw new Error(
      `platform: HTTPS is not ready for *.${manifest.pendingDomain!.baseDomain}. Existing URLs remain active. Wait for DNS/certificate activation and rerun the same domain set command.`,
    );
  }
}

export async function runPlatformDomainCommand(args: DomainArgs): Promise<void> {
  assertNoninteractivePlatformMutationAcknowledged(args, process.stdin.isTTY === true);
  const selected = await resolveInstalledPlatformManifest(args.selector);
  const credential = await resolvePlatformCloudflareCredential();
  const client = new PlatformCloudflareClient(credential.token, {
    credential: platformOperatorCredentialLabel(credential),
  });
  const domainInput =
    args.domain || (await text({ message: 'Application domain:', placeholder: 'example.com' }));
  if (isCancel(domainInput)) {
    throw new Error('platform: Cancelled.');
  }
  const domain = normalizeApplicationDomain(String(domainInput));
  const execute = async (
    manifest: PlatformInstallationManifest,
    checkpoint?: (manifest: PlatformInstallationManifest) => Promise<void>,
  ) => {
    const existingZone = args.zone
      ? null
      : await client.findZoneForHostname(manifest.account.id, domain);
    const zoneName = normalizeApplicationDomain(
      args.zone || manifest.pendingDomain?.zoneName || existingZone?.name || domain,
    );
    const target = platformDomainTarget(manifest, domain, zoneName, args.dedicatedZone);
    const deployment = createPlatformDeploymentManifest({
      ...manifest.deployment,
      application: target,
    });
    const candidate = { ...manifest, deployment };
    const plan = await createPlatformInstallPlan(
      client,
      {
        accountId: manifest.account.id,
        applicationDomain: domain,
        controlPlaneDomain: deployment.controlPlane.apiHostname ?? '',
        dedicatedZone: target.dedicatedZone,
        displayName: deployment.displayName,
        installationSlug: deployment.installationSlug,
        zoneName,
      },
      candidate,
      { authoritativeProvisionIntents: true },
    );
    note(
      [
        `Applications: *.${domain}`,
        `API stays at ${manifest.endpoints.apiUrl}`,
        'Existing workers.dev app URLs keep working.',
        ...plan.actions
          .filter((action) => action.kind === 'zone' || action.kind === 'dns-record')
          .map((action) => `${action.action} ${action.kind}: ${action.name}`),
        ...createApplicationRoutes(target).map((route) => `route ${route.pattern}`),
      ].join('\n'),
      'Application domain plan',
    );
    if (args.plan) {
      return;
    }
    assertPlatformOperatorCredentialCanApplyPlan(credential, plan);
    if (!args.yes) {
      const accepted = await confirm({
        message: 'Set up this application domain?',
        initialValue: false,
      });
      if (isCancel(accepted) || !accepted) {
        return;
      }
    }
    const routingId = manifest.resources.find((resource) => resource.key === 'routing-kv')?.id;
    if (!routingId || !checkpoint) {
      throw new Error('platform: Verified routing storage and lifecycle lock are required.');
    }
    const result = await applyPlatformDomain(client, manifest, target, plan, {
      checkpoint: async (next) => {
        await checkpoint(next);
        writeInstallationManifest(next);
        await client.putKvValue(
          next.account.id,
          routingId,
          PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
          JSON.stringify(next),
        );
      },
      verifyOwnership: (next) => verifyPlatformInstallationOwnership(client, next),
      verifyRuntimeToken: async (zoneId) => {
        const url = `${manifest.endpoints.apiUrl}/internal/platform/domain-preflight`;
        const response = await fetch(url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
          headers: {
            'Content-Type': 'application/json',
            'X-Void-Platform-Probe': createPlatformHealthProbeToken(manifest.ownershipNonce),
            ...cfAccessHeaders(process.env, url),
          },
          body: JSON.stringify({ zoneId, domain }),
        });
        const body = (await response.json()) as { ok?: boolean; installationId?: string };
        if (!response.ok || body.ok !== true || body.installationId !== manifest.id) {
          throw new Error(
            `platform: The running platform could not verify cache-purge access for ${domain}. Grant its existing runtime token Cache Purge: Purge on this zone, then rerun this command.`,
          );
        }
      },
    });
    if (result.waitingForDns) {
      note(
        `Set the domain's nameservers at its registrar to:\n${result.nameServers.join('\n')}\nThen rerun: void platform domain set ${domain}`,
        'Waiting for DNS',
      );
      return;
    }
    if (result.waitingForProtection) {
      note(
        `Domain protection is still being prepared. Existing workers.dev URLs remain active. Rerun: void platform domain set ${domain}`,
        'Preparing application domain',
      );
      return;
    }
    savePlatformConnection({
      accountId: manifest.account.id,
      apiUrl: manifest.endpoints.apiUrl!,
      applicationDomain: domain,
      displayName: deployment.displayName,
      installationId: manifest.id,
      kind: 'installed',
      proxyUrl: manifest.endpoints.proxyUrl,
    });
    printSuccess(
      `Apps now use *.${domain}. Existing workers.dev URLs remain available; the API connection is unchanged.`,
    );
  };
  if (args.plan) {
    await execute(selected);
    return;
  }
  const release = acquirePlatformLifecycleLock(
    selected.account.id,
    selected.deployment.installationSlug,
  );
  try {
    const recovery = readInstallationRecoverySecrets(selected);
    const databaseUrl = resolvePlatformInstallDatabaseUrl(recovery, selected);
    if (!databaseUrl) {
      throw new Error('platform: Supply VOID_PLATFORM_DATABASE_URL to coordinate domain setup.');
    }
    const databaseLock = await acquirePlatformDatabaseLifecycleLock(
      databaseUrl,
      selected.id,
      selected.ownershipNonce,
    );
    try {
      await execute(
        selectAuthoritativePlatformManifest(selected, databaseLock.authoritativeManifest),
        databaseLock.checkpoint,
      );
    } finally {
      await databaseLock();
    }
  } finally {
    release();
  }
}
