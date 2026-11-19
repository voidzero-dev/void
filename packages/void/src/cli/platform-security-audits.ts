import { createHash } from 'node:crypto';
import type { PlatformDeploymentManifest, PlatformInstallationManifest } from '@void/platform';
import {
  PlatformCloudflareApiError,
  type PlatformCloudflareClient,
} from './platform-cloudflare.ts';

/**
 * A runtime without the scanner classes must not be paired with the capability: the
 * API would report security audits as installed and have nothing to run them.
 */
export function assertPlatformSecurityAuditsSupported(
  deployment: PlatformDeploymentManifest,
  runtime: Readonly<{ securityAudits?: 1 }>,
): void {
  if (deployment.capabilities.securityAudits && runtime.securityAudits !== 1) {
    throw new Error(
      'platform: This platform runtime does not include security audits. Use a current packaged runtime, or leave out --security-audits.',
    );
  }
}

// The scanner is created by the API Worker at turn-on (platform/packages/api/src/provisioning/
// security-scanner.ts). Names and the ownership marker are derived the same way here, because
// the installer record does not list resources the API creates.
const OWNER_BINDING = '__VOID_SECURITY_SCANNER_OWNER';
const PROTOCOL = 1;

type ScannerClient = Pick<PlatformCloudflareClient, 'request'>;

type Binding = { type: string; name: string; text?: string; namespace_id?: string };

export function securityScannerNames(installationId: string): {
  worker: string;
  application: string;
  gate: string;
} {
  const suffix = createHash('sha256')
    .update(`void-security-scanner:${installationId}`)
    .digest('hex')
    .slice(0, 12);
  return {
    worker: `void-security-scanner-${suffix}`,
    application: `void-security-scanner-${suffix}`,
    gate: `void-security-scanner-gate-${suffix}`,
  };
}

function ownerMarker(installationId: string): string {
  return JSON.stringify({ protocol: PROTOCOL, installation: installationId });
}

function plainText(bindings: ReadonlyArray<Binding>): string | undefined {
  return bindings.find((binding) => binding.type === 'plain_text' && binding.name === OWNER_BINDING)
    ?.text;
}

async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PlatformCloudflareApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function optionalOrForbidden<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof PlatformCloudflareApiError &&
      (error.status === 403 || error.status === 404)
    ) {
      return undefined;
    }
    throw error;
  }
}

async function deleteIfPresent(client: ScannerClient, path: string): Promise<void> {
  await optional(() => client.request(path, { method: 'DELETE' }));
}

export type SecurityScannerTeardown = Readonly<{
  /** Cloudflare objects removed, in order. */
  deleted: ReadonlyArray<'gate' | 'container application' | 'controller'>;
  /** Objects with the scanner's name that are not this installation's. They stay. */
  kept: ReadonlyArray<string>;
}>;

/**
 * Uninstall: the gate first (nothing can call in), then the billable container
 * application, then the controller Worker. Each is found by its derived name and proven
 * ours by the ownership marker; one that is not ours is left alone and reported.
 * With the capability off this makes no Cloudflare call at all.
 */
export async function deletePlatformSecurityScanner(
  client: ScannerClient,
  manifest: PlatformInstallationManifest,
): Promise<SecurityScannerTeardown> {
  if (!manifest.deployment.capabilities.securityAudits) {
    return { deleted: [], kept: [] };
  }
  const account = encodeURIComponent(manifest.account.id);
  const names = securityScannerNames(manifest.id);
  const marker = ownerMarker(manifest.id);
  const deleted: Array<'gate' | 'container application' | 'controller'> = [];
  const kept: Array<string> = [];

  const gatePath = `/accounts/${account}/workers/dispatch/namespaces/${encodeURIComponent(
    manifest.deployment.resources.dispatchNamespace,
  )}/scripts/${names.gate}`;
  const gate = await optional(() => client.request<unknown>(gatePath));
  if (gate !== undefined) {
    const bindings = await client.request<ReadonlyArray<Binding>>(`${gatePath}/bindings`);
    if (plainText(bindings) === marker) {
      await deleteIfPresent(client, gatePath);
      deleted.push('gate');
    } else {
      kept.push(`security scanner gate ${names.gate}`);
    }
  }

  const workerPath = `/accounts/${account}/workers/scripts/${names.worker}`;
  const settings = await optional(() =>
    client.request<{ bindings: ReadonlyArray<Binding> }>(`${workerPath}/settings`),
  );
  // The capability is on from install, but the scanner is created only when an admin
  // first leaves `disabled`. With no controller there is nothing to remove, so a token
  // without Containers rights (403) or a missing list (404) is not a failure.
  const listApplications = () =>
    client.request<
      ReadonlyArray<{ id: string; name: string; durable_objects?: { namespace_id?: string } }>
    >(`/accounts/${account}/containers/applications?name=${encodeURIComponent(names.application)}`);
  const applications = settings
    ? await listApplications()
    : ((await optionalOrForbidden(listApplications)) ?? []);
  const application = applications.find((entry) => entry.name === names.application);
  if (!settings) {
    // A container application whose controller is gone cannot be proven ours.
    if (application) {
      kept.push(`security scanner container application ${names.application}`);
    }
    return { deleted, kept };
  }
  if (plainText(settings.bindings) !== marker) {
    kept.push(`security scanner controller ${names.worker}`);
    if (application) {
      kept.push(`security scanner container application ${names.application}`);
    }
    return { deleted, kept };
  }
  if (application) {
    const namespace = settings.bindings.find(
      (binding) => binding.type === 'durable_object_namespace' && binding.name === 'SCANNER',
    )?.namespace_id;
    if (namespace !== undefined && application.durable_objects?.namespace_id === namespace) {
      await deleteIfPresent(
        client,
        `/accounts/${account}/containers/applications/${application.id}`,
      );
      deleted.push('container application');
    } else {
      kept.push(`security scanner container application ${names.application}`);
    }
  }
  await deleteIfPresent(client, workerPath);
  deleted.push('controller');
  return { deleted, kept };
}
