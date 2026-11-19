import { createHash } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
} from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';
import { PlatformCloudflareApiError } from '../../src/cli/platform-cloudflare.ts';
import {
  assertPlatformSecurityAuditsSupported,
  deletePlatformSecurityScanner,
  securityScannerNames,
} from '../../src/cli/platform-security-audits.ts';

const INSTALLATION = 'example-a1b2c3d4';

function manifest(securityAudits: boolean) {
  return createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-14T00:00:00.000Z',
    deployment: createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      capabilities: { securityAudits },
      controlPlane: { apiHostname: 'api.example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    }),
    id: INSTALLATION,
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
}

const marker = (installation = INSTALLATION) => JSON.stringify({ protocol: 1, installation });
const owner = (installation = INSTALLATION) => [
  { type: 'plain_text', name: '__VOID_SECURITY_SCANNER_OWNER', text: marker(installation) },
];

/** A Cloudflare account holding the scanner: gate, controller Worker and container application. */
function account(
  options: {
    gate?: 'ours' | 'foreign' | 'missing';
    controller?: 'ours' | 'foreign' | 'missing';
    application?: 'ours' | 'other-namespace' | 'missing';
    /** The Engine A container application and its copied image (M13b). */
    engineA?: boolean;
    failOn?: string;
    /** Registry answers for the image manifest HEAD and the layer cleanup. */
    headStatus?: number;
    gcStatus?: number;
  } = {},
) {
  const {
    gate = 'ours',
    controller = 'ours',
    application = 'ours',
    engineA = false,
    failOn,
    headStatus = 200,
    gcStatus = 202,
  } = options;
  const names = securityScannerNames(INSTALLATION);
  const calls: Array<string> = [];
  const registryCalls: Array<string> = [];
  const engineRepo = `account/${names.engines['engine-a'].repository}`;
  let engineImage = engineA;
  const registryFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    registryCalls.push(`${method} ${path}`);
    if (path === `/v2/${engineRepo}/tags/list`) {
      return engineImage
        ? Response.json({ tags: ['sha256-aaa'] })
        : new Response(null, { status: 404 });
    }
    if (path === `/v2/${engineRepo}/manifests/sha256-aaa` && method === 'HEAD') {
      return new Response(null, {
        status: headStatus,
        headers: headStatus === 200 ? { 'docker-content-digest': 'sha256:aaa' } : {},
      });
    }
    if (path === `/v2/${engineRepo}/manifests/sha256:aaa` && method === 'DELETE') {
      engineImage = false;
      return new Response(null, { status: 202 });
    }
    if (path === '/v2/gc/layers') {
      return new Response(null, { status: gcStatus });
    }
    return new Response(null, { status: 404 });
  };
  const gatePath = `/accounts/account/workers/dispatch/namespaces/${manifest(true).deployment.resources.dispatchNamespace}/scripts/${names.gate}`;
  const workerPath = `/accounts/account/workers/scripts/${names.worker}`;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (failOn && `${method} ${path}`.includes(failOn)) {
      throw new PlatformCloudflareApiError('forbidden', 403, path);
    }
    const missing = () => new PlatformCloudflareApiError('not found', 404, path);
    if (path === gatePath) {
      if (gate === 'missing') {
        throw missing();
      }
      return {} as T;
    }
    if (path === `${gatePath}/bindings`) {
      return (gate === 'ours' ? owner() : owner('someone-else')) as T;
    }
    if (path === `${workerPath}/settings`) {
      if (controller === 'missing') {
        throw missing();
      }
      return {
        bindings: [
          ...(controller === 'ours' ? owner() : owner('someone-else')),
          { type: 'durable_object_namespace', name: 'SCANNER', namespace_id: 'ns-1' },
          { type: 'durable_object_namespace', name: 'SCANNER_ENGINE_A', namespace_id: 'ns-a' },
          { type: 'durable_object_namespace', name: 'SCANNER_ENGINE_C', namespace_id: 'ns-c' },
        ],
      } as T;
    }
    if (path === '/accounts/account/containers/registries/registry.cloudflare.com/credentials') {
      return { username: 'v1', password: 'registry-password' } as T;
    }
    if (path.startsWith('/accounts/account/containers/applications?name=')) {
      const name = decodeURIComponent(path.slice(path.indexOf('=') + 1));
      if (name === names.engines['engine-a'].application) {
        return (
          engineA ? [{ id: 'app-a', name, durable_objects: { namespace_id: 'ns-a' } }] : []
        ) as T;
      }
      if (name !== names.application) {
        return [] as T;
      }
      return (
        application === 'missing'
          ? []
          : [
              {
                id: 'app-1',
                name: names.application,
                durable_objects: { namespace_id: application === 'ours' ? 'ns-1' : 'ns-other' },
              },
            ]
      ) as T;
    }
    if (method === 'DELETE') {
      return null as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { request, calls, names, gatePath, workerPath, registryFetch, registryCalls };
}

describe('security scanner names', () => {
  it('match the platform API, which derives them from the installation id', () => {
    const suffix = createHash('sha256')
      .update(`void-security-scanner:${INSTALLATION}`)
      .digest('hex')
      .slice(0, 12);
    expect(securityScannerNames(INSTALLATION)).toEqual({
      worker: `void-security-scanner-${suffix}`,
      application: `void-security-scanner-${suffix}`,
      gate: `void-security-scanner-gate-${suffix}`,
      engines: {
        'engine-a': {
          application: `void-security-scanner-engine-a-${suffix}`,
          repository: `void-security-scanner-engine-a-${suffix}`,
        },
        'engine-c': {
          application: `void-security-scanner-engine-c-${suffix}`,
          repository: `void-security-scanner-engine-c-${suffix}`,
        },
      },
    });
    expect(securityScannerNames('other').worker).not.toBe(
      securityScannerNames(INSTALLATION).worker,
    );
  });
});

describe('security audits runtime guard', () => {
  const deployment = (securityAudits: boolean) => manifest(securityAudits).deployment;
  it('refuses the capability on a runtime without the scanner', () => {
    expect(() => assertPlatformSecurityAuditsSupported(deployment(true), {})).toThrow(
      'does not include security audits',
    );
    expect(() =>
      assertPlatformSecurityAuditsSupported(deployment(true), { securityAudits: 1 }),
    ).not.toThrow();
    expect(() => assertPlatformSecurityAuditsSupported(deployment(false), {})).not.toThrow();
  });
});

describe('deleting the security scanner', () => {
  it('makes no Cloudflare call when security audits were never allowed', async () => {
    const cloudflare = account();
    expect(await deletePlatformSecurityScanner(cloudflare, manifest(false))).toEqual({
      deleted: [],
      kept: [],
    });
    expect(cloudflare.calls).toEqual([]);
  });

  it('deletes the gate, then the container application, then the controller', async () => {
    const cloudflare = account();
    const result = await deletePlatformSecurityScanner(
      cloudflare,
      manifest(true),
      cloudflare.registryFetch,
    );
    expect(result).toEqual({ deleted: ['gate', 'container application', 'controller'], kept: [] });
    expect(cloudflare.calls.filter((call) => call.startsWith('DELETE'))).toEqual([
      `DELETE ${cloudflare.gatePath}`,
      'DELETE /accounts/account/containers/applications/app-1',
      `DELETE ${cloudflare.workerPath}`,
    ]);
  });

  it('also removes the engine container applications and the copied engine images', async () => {
    const cloudflare = account({ engineA: true });
    const result = await deletePlatformSecurityScanner(
      cloudflare,
      manifest(true),
      cloudflare.registryFetch,
    );
    expect(result).toEqual({
      deleted: ['gate', 'container application', 'controller', 'scanner images'],
      kept: [],
    });
    expect(cloudflare.calls.filter((call) => call.startsWith('DELETE'))).toEqual([
      `DELETE ${cloudflare.gatePath}`,
      'DELETE /accounts/account/containers/applications/app-1',
      'DELETE /accounts/account/containers/applications/app-a',
      `DELETE ${cloudflare.workerPath}`,
    ]);
    const repo = cloudflare.names.engines['engine-a'].repository;
    expect(cloudflare.registryCalls).toContain(`DELETE /v2/account/${repo}/manifests/sha256:aaa`);
    expect(cloudflare.registryCalls.at(-1)).toBe('PUT /v2/gc/layers');
  });

  it('fails, so it can be run again, when an image cannot be read or the cleanup fails', async () => {
    const unreadable = account({ engineA: true, headStatus: 500 });
    await expect(
      deletePlatformSecurityScanner(unreadable, manifest(true), unreadable.registryFetch),
    ).rejects.toThrow('(HTTP 500)');
    const cleanup = account({ engineA: true, gcStatus: 500 });
    await expect(
      deletePlatformSecurityScanner(cleanup, manifest(true), cleanup.registryFetch),
    ).rejects.toThrow('The registry layer cleanup failed (HTTP 500).');
  });

  it('succeeds again when everything is already gone', async () => {
    const cloudflare = account({ gate: 'missing', controller: 'missing', application: 'missing' });
    expect(
      await deletePlatformSecurityScanner(cloudflare, manifest(true), cloudflare.registryFetch),
    ).toEqual({
      deleted: [],
      kept: [],
    });
    expect(cloudflare.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('keeps objects that carry another installation’s marker', async () => {
    const cloudflare = account({ gate: 'foreign', controller: 'foreign' });
    const result = await deletePlatformSecurityScanner(
      cloudflare,
      manifest(true),
      cloudflare.registryFetch,
    );
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual([
      `security scanner gate ${cloudflare.names.gate}`,
      `security scanner controller ${cloudflare.names.worker}`,
      `security scanner container application ${cloudflare.names.application}`,
    ]);
    expect(cloudflare.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('keeps a container application whose controller is gone or of another namespace', async () => {
    const orphan = account({ controller: 'missing' });
    expect(
      (await deletePlatformSecurityScanner(orphan, manifest(true), orphan.registryFetch)).kept,
    ).toEqual([`security scanner container application ${orphan.names.application}`]);
    expect(orphan.calls).not.toContain('DELETE /accounts/account/containers/applications/app-1');

    const other = account({ application: 'other-namespace' });
    const result = await deletePlatformSecurityScanner(other, manifest(true), other.registryFetch);
    expect(result.deleted).toEqual(['gate', 'controller']);
    expect(result.kept).toEqual([
      `security scanner container application ${other.names.application}`,
    ]);
  });

  it('treats a refused application list as nothing to remove when no controller exists', async () => {
    const cloudflare = account({
      controller: 'missing',
      application: 'missing',
      failOn: 'GET /accounts/account/containers/applications',
    });
    expect(
      await deletePlatformSecurityScanner(cloudflare, manifest(true), cloudflare.registryFetch),
    ).toEqual({
      deleted: ['gate'],
      kept: [],
    });
  });

  it('still fails on a refused application list when the controller exists', async () => {
    const cloudflare = account({ failOn: 'GET /accounts/account/containers/applications' });
    await expect(
      deletePlatformSecurityScanner(cloudflare, manifest(true), cloudflare.registryFetch),
    ).rejects.toThrow('forbidden');
    expect(cloudflare.calls).not.toContain(`DELETE ${cloudflare.workerPath}`);
  });

  it('stops on an API error so the uninstall can be run again', async () => {
    const cloudflare = account({
      failOn: 'DELETE /accounts/account/containers/applications/app-1',
    });
    await expect(
      deletePlatformSecurityScanner(cloudflare, manifest(true), cloudflare.registryFetch),
    ).rejects.toThrow('forbidden');
    // The controller is kept while its container application still exists.
    expect(cloudflare.calls).not.toContain(`DELETE ${cloudflare.workerPath}`);
  });
});
