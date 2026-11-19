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
    failOn?: string;
  } = {},
) {
  const { gate = 'ours', controller = 'ours', application = 'ours', failOn } = options;
  const names = securityScannerNames(INSTALLATION);
  const calls: Array<string> = [];
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
        ],
      } as T;
    }
    if (path.startsWith('/accounts/account/containers/applications?name=')) {
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
  return { request, calls, names, gatePath, workerPath };
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
    const result = await deletePlatformSecurityScanner(cloudflare, manifest(true));
    expect(result).toEqual({ deleted: ['gate', 'container application', 'controller'], kept: [] });
    expect(cloudflare.calls.filter((call) => call.startsWith('DELETE'))).toEqual([
      `DELETE ${cloudflare.gatePath}`,
      'DELETE /accounts/account/containers/applications/app-1',
      `DELETE ${cloudflare.workerPath}`,
    ]);
  });

  it('succeeds again when everything is already gone', async () => {
    const cloudflare = account({ gate: 'missing', controller: 'missing', application: 'missing' });
    expect(await deletePlatformSecurityScanner(cloudflare, manifest(true))).toEqual({
      deleted: [],
      kept: [],
    });
    expect(cloudflare.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('keeps objects that carry another installation’s marker', async () => {
    const cloudflare = account({ gate: 'foreign', controller: 'foreign' });
    const result = await deletePlatformSecurityScanner(cloudflare, manifest(true));
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
    expect((await deletePlatformSecurityScanner(orphan, manifest(true))).kept).toEqual([
      `security scanner container application ${orphan.names.application}`,
    ]);
    expect(orphan.calls).not.toContain('DELETE /accounts/account/containers/applications/app-1');

    const other = account({ application: 'other-namespace' });
    const result = await deletePlatformSecurityScanner(other, manifest(true));
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
    expect(await deletePlatformSecurityScanner(cloudflare, manifest(true))).toEqual({
      deleted: ['gate'],
      kept: [],
    });
  });

  it('still fails on a refused application list when the controller exists', async () => {
    const cloudflare = account({ failOn: 'GET /accounts/account/containers/applications' });
    await expect(deletePlatformSecurityScanner(cloudflare, manifest(true))).rejects.toThrow(
      'forbidden',
    );
    expect(cloudflare.calls).not.toContain(`DELETE ${cloudflare.workerPath}`);
  });

  it('stops on an API error so the uninstall can be run again', async () => {
    const cloudflare = account({
      failOn: 'DELETE /accounts/account/containers/applications/app-1',
    });
    await expect(deletePlatformSecurityScanner(cloudflare, manifest(true))).rejects.toThrow(
      'forbidden',
    );
    // The controller is kept while its container application still exists.
    expect(cloudflare.calls).not.toContain(`DELETE ${cloudflare.workerPath}`);
  });
});
