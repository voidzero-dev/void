import { createHash } from 'node:crypto';
import type { PlatformDeploymentManifest, PlatformInstallationManifest } from '@void/platform';
import { Buffer } from './node-buffer.ts';
import { PlatformCloudflareApiError } from './platform-cloudflare.ts';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';

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

/** Engines A and C each have a container application and a copied image (API M13b). */
const ENGINES = [
  { slug: 'engine-a', binding: 'SCANNER_ENGINE_A' },
  { slug: 'engine-c', binding: 'SCANNER_ENGINE_C' },
] as const;

export type SecurityScannerEngineNames = { application: string; repository: string };

export function securityScannerNames(installationId: string): {
  worker: string;
  application: string;
  gate: string;
  engines: { 'engine-a': SecurityScannerEngineNames; 'engine-c': SecurityScannerEngineNames };
} {
  const suffix = createHash('sha256')
    .update(`void-security-scanner:${installationId}`)
    .digest('hex')
    .slice(0, 12);
  const engine = (slug: string): SecurityScannerEngineNames => ({
    application: `void-security-scanner-${slug}-${suffix}`,
    repository: `void-security-scanner-${slug}-${suffix}`,
  });
  return {
    worker: `void-security-scanner-${suffix}`,
    application: `void-security-scanner-${suffix}`,
    gate: `void-security-scanner-gate-${suffix}`,
    engines: { 'engine-a': engine('engine-a'), 'engine-c': engine('engine-c') },
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

type Deleted = 'gate' | 'container application' | 'controller' | 'scanner images';

export type SecurityScannerTeardown = Readonly<{
  /** Cloudflare objects removed, in order. */
  deleted: ReadonlyArray<Deleted>;
  /** Objects with the scanner's name that are not this installation's. They stay. */
  kept: ReadonlyArray<string>;
}>;

const REGISTRY = 'registry.cloudflare.com';
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

type RegistryFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Removes every manifest in the engine image repositories the API copied into this
 * account (one per engine, named per installation), then the unreferenced layers.
 * Returns whether anything was removed.
 */
async function deleteScannerImages(
  client: ScannerClient,
  registryFetch: RegistryFetch,
  account: string,
  repositories: ReadonlyArray<string>,
  controllerExists: boolean,
): Promise<boolean> {
  const read = () =>
    client.request<{ username?: unknown; password?: unknown }>(
      `/accounts/${encodeURIComponent(account)}/containers/registries/${REGISTRY}/credentials`,
      {
        method: 'POST',
        body: JSON.stringify({ expiration_minutes: 15, permissions: ['push', 'pull'] }),
      },
    );
  // With no controller the images are most likely not there either, so a token without
  // Containers rights is not a failure (as for the application list).
  const credentials = controllerExists ? await read() : await optionalOrForbidden(read);
  if (
    !credentials ||
    typeof credentials.username !== 'string' ||
    typeof credentials.password !== 'string'
  ) {
    return false;
  }
  const auth = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  const call = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', auth);
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', MANIFEST_ACCEPT);
    }
    return registryFetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  };
  let removed = false;
  for (const repository of repositories) {
    const base = `https://${REGISTRY}/v2/${account}/${repository}`;
    const list = await call(`${base}/tags/list`);
    if (list.status === 404) {
      await list.body?.cancel();
      continue;
    }
    if (!list.ok) {
      await list.body?.cancel();
      throw new Error(
        `platform: Listing the security scanner images failed (HTTP ${list.status}).`,
      );
    }
    const { tags } = await list.json<{ tags?: unknown }>();
    for (const tag of Array.isArray(tags) ? tags : []) {
      if (typeof tag !== 'string') {
        continue;
      }
      const head = await call(`${base}/manifests/${encodeURIComponent(tag)}`, { method: 'HEAD' });
      await head.body?.cancel();
      if (head.status === 404) {
        continue;
      }
      const digest = head.headers.get('docker-content-digest');
      if (head.status !== 200 || !digest) {
        // Never report the cleanup as done while an image may still be stored.
        throw new Error(
          `platform: Reading security scanner image ${repository}:${tag} failed (HTTP ${head.status}).`,
        );
      }
      const deleted = await call(`${base}/manifests/${digest}`, { method: 'DELETE' });
      await deleted.body?.cancel();
      if (!deleted.ok && deleted.status !== 404) {
        throw new Error(
          `platform: Deleting a security scanner image failed (HTTP ${deleted.status}).`,
        );
      }
      removed = true;
    }
  }
  if (removed) {
    const gc = await call(`https://${REGISTRY}/v2/gc/layers`, { method: 'PUT' });
    await gc.body?.cancel();
    if (!gc.ok) {
      throw new Error(`platform: The registry layer cleanup failed (HTTP ${gc.status}).`);
    }
  }
  return removed;
}

/**
 * Uninstall: the gate first (nothing can call in), then the billable container
 * applications (Engine B and one per engine image), then the controller Worker, then the
 * engine images copied into the account registry. Each is found by its derived name and
 * proven ours by the ownership marker (an application also by its controller's Durable
 * Object namespace); one that is not ours is left alone and reported. With the
 * capability off this makes no Cloudflare call at all.
 */
export async function deletePlatformSecurityScanner(
  client: ScannerClient,
  manifest: PlatformInstallationManifest,
  registryFetch: RegistryFetch = (input, init) => fetch(input, init),
): Promise<SecurityScannerTeardown> {
  if (!manifest.deployment.capabilities.securityAudits) {
    return { deleted: [], kept: [] };
  }
  const account = encodeURIComponent(manifest.account.id);
  const names = securityScannerNames(manifest.id);
  const marker = ownerMarker(manifest.id);
  const deleted: Array<Deleted> = [];
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
  const targets = [
    { name: names.application, binding: 'SCANNER' },
    ...ENGINES.map((engine) => ({
      name: names.engines[engine.slug].application,
      binding: engine.binding,
    })),
  ];
  const found: Array<{ name: string; binding: string; id: string; namespace?: string }> = [];
  for (const target of targets) {
    const listApplications = () =>
      client.request<
        ReadonlyArray<{ id: string; name: string; durable_objects?: { namespace_id?: string } }>
      >(`/accounts/${account}/containers/applications?name=${encodeURIComponent(target.name)}`);
    const applications = settings
      ? await listApplications()
      : ((await optionalOrForbidden(listApplications)) ?? []);
    const application = applications.find((entry) => entry.name === target.name);
    if (application) {
      found.push({
        ...target,
        id: application.id,
        namespace: application.durable_objects?.namespace_id,
      });
    }
  }
  const repositories = ENGINES.map((engine) => names.engines[engine.slug].repository);
  if (!settings) {
    // A container application whose controller is gone cannot be proven ours.
    for (const application of found) {
      kept.push(`security scanner container application ${application.name}`);
    }
    if (
      await deleteScannerImages(client, registryFetch, manifest.account.id, repositories, false)
    ) {
      deleted.push('scanner images');
    }
    return { deleted, kept };
  }
  if (plainText(settings.bindings) !== marker) {
    kept.push(`security scanner controller ${names.worker}`);
    for (const application of found) {
      kept.push(`security scanner container application ${application.name}`);
    }
    return { deleted, kept };
  }
  let removedApplication = false;
  for (const application of found) {
    const namespace = settings.bindings.find(
      (binding) =>
        binding.type === 'durable_object_namespace' && binding.name === application.binding,
    )?.namespace_id;
    if (namespace !== undefined && application.namespace === namespace) {
      await deleteIfPresent(
        client,
        `/accounts/${account}/containers/applications/${application.id}`,
      );
      removedApplication = true;
    } else {
      kept.push(`security scanner container application ${application.name}`);
    }
  }
  if (removedApplication) {
    deleted.push('container application');
  }
  await deleteIfPresent(client, workerPath);
  deleted.push('controller');
  if (await deleteScannerImages(client, registryFetch, manifest.account.id, repositories, true)) {
    deleted.push('scanner images');
  }
  return { deleted, kept };
}
