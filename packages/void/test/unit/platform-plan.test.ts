import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  createPlatformResourceNames,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationEndpoints,
  type InstallationResourceKind,
  type PlatformInstallationManifest,
} from '@void/platform';
import { describe, expect, it, vi } from 'vite-plus/test';
import { pc } from '../../src/cli/output.ts';
import {
  PlatformCloudflareApiError,
  PlatformCloudflareClient,
} from '../../src/cli/platform-cloudflare.ts';
import { platformDomainTarget } from '../../src/cli/platform-domain.ts';
import { recordProvisionIntent } from '../../src/cli/platform-installer-resources.ts';
import { installPlatform } from '../../src/cli/platform-installer.ts';
import { verifyPlatformAiGatewayPlan } from '../../src/cli/platform-lifecycle.ts';
import {
  createPlatformInstallPlan,
  formatPlatformInstallPlan,
  platformProvisionIntentHash,
  revalidatePlatformInstallAction,
  type PlatformInstallPlan,
} from '../../src/cli/platform-plan.ts';
import { ownershipMarker } from '../helpers/platform-installation.ts';

function client(overrides: Record<string, unknown> = {}) {
  return {
    listAccounts: async () => [{ id: 'account', name: 'Account' }],
    getWorkersSubdomain: async () => 'example',
    hasActiveCertificateForHostname: async () => true,
    getKvValue: async () => null,
    listAiGateways: async () => [],
    findZone: async () => null,
    findZoneForHostname: async () => null,
    listDnsRecords: async () => [],
    getR2Object: async () => null,
    getWorkerPlainTextBindings: async () => ({}),
    listKvNamespaces: async () => [],
    listR2Buckets: async () => [],
    listQueues: async () => [],
    listDispatchNamespaces: async () => [],
    listHyperdriveConfigs: async () => [],
    listWorkerNames: async () => [],
    listWorkerDomains: async () => [],
    listWorkerRoutes: async () => [],
    ...overrides,
  };
}

const input = {
  accountId: 'account',
  applicationDomain: 'example.app',
  controlPlaneDomain: '',
  dedicatedZone: false,
  displayName: 'Example',
  installationSlug: 'example',
  zoneName: 'example.app',
};

function r2ConfigHash(name: string, fingerprint: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ fingerprint, kind: 'r2-bucket', name }))
    .digest('hex');
}

function legacyInstallation(suffix = '0123456789ab') {
  return createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-14T00:00:00.000Z',
    deployment: createPlatformDeploymentManifest({
      installationSlug: input.installationSlug,
      displayName: input.displayName,
      application: { baseDomain: input.applicationDomain, zoneName: input.zoneName },
      resources: createPlatformResourceNames(`example-${suffix}`),
    }),
    id: 'example-0123456789ab',
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
}

function manifestFor(
  plan: Pick<PlatformInstallPlan, 'account' | 'deployment' | 'installationId'>,
  createdAt = '2026-09-14T00:00:00.000Z',
) {
  return createPlatformInstallationManifest({
    account: plan.account,
    createdAt,
    deployment: plan.deployment,
    id: plan.installationId,
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
}

function defaultManifest() {
  return createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-14T00:00:00.000Z',
    deployment: createPlatformDeploymentManifest({
      application: { baseDomain: 'example.app', zoneName: 'example.app' },
      displayName: 'Example',
      installationSlug: 'example',
    }),
    id: 'example-a1b2c3d4',
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
}

function markerFor(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  name: string,
): string {
  return ownershipMarker(manifest, { id: name, key, kind, name });
}

const activeZone = { id: 'zone', name: 'example.app', nameServers: [], status: 'active' };

describe('platform installation planning', () => {
  it('provisions the deployment Queue only for a runtime that supports its consumer', async () => {
    const listQueues = vi.fn(async () => []);
    const old = await createPlatformInstallPlan(client({ listQueues }), input, null);
    expect(old.actions).not.toContainEqual(expect.objectContaining({ key: 'deployment-queue' }));
    expect(listQueues.mock.calls).not.toContainEqual(['account', 'void-example-deployments']);
    const current = await createPlatformInstallPlan(client({ listQueues }), input, null, {
      deploymentExecution: true,
    });
    expect(current.actions).toContainEqual(
      expect.objectContaining({
        action: 'create',
        key: 'deployment-queue',
        kind: 'queue',
        name: 'void-example-deployments',
      }),
    );
    expect(listQueues.mock.calls).toContainEqual(['account', 'void-example-deployments']);
  });

  it('rejects a deployment Queue name collision without installation ownership', async () => {
    await expect(
      createPlatformInstallPlan(
        client({
          listQueues: async (_account: string, name: string) =>
            name === 'void-example-deployments' ? [{ id: 'someone-elses-queue', name }] : [],
        }),
        input,
        null,
        { deploymentExecution: true },
      ),
    ).rejects.toThrow('not owned');
  });

  it('recovers and revalidates the owned deployment Queue without replacing its recorded name', async () => {
    let manifest = legacyInstallation();
    manifest = {
      ...manifest,
      deployment: createPlatformDeploymentManifest({
        ...manifest.deployment,
        resources: {
          ...manifest.deployment.resources,
          deploymentQueue: 'void-example-deployments-legacy',
        },
      }),
    };
    for (const resource of [
      {
        key: 'routing-kv',
        kind: 'kv-namespace' as const,
        name: manifest.deployment.resources.routingKv,
      },
      {
        key: 'deployment-queue',
        kind: 'queue' as const,
        name: manifest.deployment.resources.deploymentQueue,
      },
    ]) {
      manifest = recordInstallationResource(
        manifest,
        {
          ...resource,
          id: `${resource.key}-id`,
          ownership: 'created',
          state: 'ready',
          configHash: 'fixture',
        },
        '2026-10-01T00:00:00.000Z',
      );
    }
    const api = client({
      listKvNamespaces: async (_account: string, name: string) =>
        name === manifest.deployment.resources.routingKv
          ? [{ id: 'routing-kv-id', title: name }]
          : [],
      listQueues: async (_account: string, name: string) =>
        name === manifest.deployment.resources.deploymentQueue
          ? [{ id: 'deployment-queue-id', name }]
          : [],
      getKvValue: async () => JSON.stringify(manifest),
    });
    const recovered = await createPlatformInstallPlan(api, input, manifest);
    const queue = recovered.actions.find((action) => action.key === 'deployment-queue')!;
    expect(queue).toMatchObject({
      action: 'reuse',
      id: 'deployment-queue-id',
      name: 'void-example-deployments-legacy',
    });
    await expect(
      revalidatePlatformInstallAction(api, recovered, manifest, queue),
    ).resolves.toBeUndefined();
    const unsupported = await createPlatformInstallPlan(api, input, manifest, {
      deploymentExecution: false,
    });
    expect(unsupported.actions).not.toContainEqual(
      expect.objectContaining({ key: 'deployment-queue' }),
    );
    expect(manifest.resources).toContainEqual(
      expect.objectContaining({ key: 'deployment-queue', state: 'ready' }),
    );
  });

  it('keeps dashboard configuration optional and preserves it across resumed lifecycle plans', async () => {
    const without = await createPlatformInstallPlan(client(), input, null);
    const withDashboard = await createPlatformInstallPlan(
      client(),
      { ...input, dashboardUrl: 'https://dash.example.org:8443/' },
      null,
    );
    expect(without.deployment.controlPlane.dashboardHostname).toBeNull();
    expect(without.deployment.controlPlane).not.toHaveProperty('dashboardUrl');
    expect(withDashboard.actions).toEqual(without.actions);
    expect(withDashboard.deployment.capabilities).toEqual(without.deployment.capabilities);
    expect(withDashboard.installationId).toEqual(without.installationId);
    const recorded = createPlatformInstallationManifest({
      account: withDashboard.account,
      createdAt: '2026-10-01T00:00:00.000Z',
      deployment: withDashboard.deployment,
      id: withDashboard.installationId,
      ownershipNonce: 'a'.repeat(43),
      platformVersion: '1.0.0',
    });
    const resumed = await createPlatformInstallPlan(client(), input, recorded, {
      repairMissing: true,
    });
    expect(resumed.deployment.controlPlane).toMatchObject({
      dashboardHostname: 'dash.example.org',
      dashboardUrl: 'https://dash.example.org:8443',
    });
    const changed = await createPlatformInstallPlan(
      client(),
      { ...input, dashboardUrl: 'https://new.example.org' },
      recorded,
    );
    expect(changed.deployment.controlPlane.dashboardUrl).toBe('https://new.example.org');
    expect(formatPlatformInstallPlan(resumed)).toContain('https://dash.example.org:8443');
  });

  it('retains an existing advertised origin and rejects malformed configuration before provider reads', async () => {
    const recorded = setInstallationEndpoints(
      legacyInstallation(),
      { apiUrl: null, proxyUrl: null, dashboardUrl: 'https://legacy.example.org:8443' },
      '2026-09-14T00:00:01.000Z',
    );
    const plan = await createPlatformInstallPlan(client(), input, recorded);
    expect(plan.deployment.controlPlane.dashboardUrl).toBe('https://legacy.example.org:8443');
    const listAccounts = vi.fn(async () => []);
    await expect(
      createPlatformInstallPlan(
        client({ listAccounts }),
        { ...input, dashboardUrl: 'https://user:secret@dash.example.org' },
        null,
      ),
    ).rejects.toThrow('HTTPS origin');
    expect(listAccounts).not.toHaveBeenCalled();
  });
  it('adopts an explicitly selected Hyperdrive without coupling its name to the installation', async () => {
    const fake = client({
      listHyperdriveConfigs: async () => [
        { id: 'other-id', name: 'void-example-database' },
        { id: 'terraform-id', name: 'company-managed-postgres' },
      ],
    });
    await expect(createPlatformInstallPlan(fake, input, null)).rejects.toThrow('not owned');
    const externalHyperdrive = {
      id: 'terraform-id',
      name: 'company-managed-postgres',
      database: 'void_platform',
      host: 'hyperdrive-productiondb.databases.cfdata.org/itdb/primary',
      user: 'hyperdrive_void_platform_service',
    };
    const plan = await createPlatformInstallPlan(fake, { ...input, externalHyperdrive }, null);
    expect(plan.actions.find((action) => action.key === 'hyperdrive')).toMatchObject({
      action: 'adopt',
      id: 'terraform-id',
      name: 'company-managed-postgres',
    });
    expect(plan.deployment.resources.hyperdrive).toBe('company-managed-postgres');
    expect(stripVTControlCharacters(formatPlatformInstallPlan(plan))).toContain(
      'Database: void_platform via Hyperdrive company-managed-postgres',
    );
    const recorded = recordInstallationResource(
      createPlatformInstallationManifest({
        account: plan.account,
        createdAt: '2026-09-25T00:00:00.000Z',
        deployment: plan.deployment,
        id: plan.installationId,
        ownershipNonce: 'a'.repeat(43),
        platformVersion: '1.0.0',
      }),
      {
        key: 'hyperdrive',
        kind: 'hyperdrive',
        id: 'terraform-id',
        name: 'company-managed-postgres',
        ownership: 'adopted',
        state: 'ready',
        configHash: '0'.repeat(64),
      },
      '2026-09-25T00:00:00.000Z',
    );
    const resumed = await createPlatformInstallPlan(fake, input, recorded);
    expect(resumed.actions.find((action) => action.key === 'hyperdrive')).toMatchObject({
      action: 'reuse',
      id: 'terraform-id',
      name: 'company-managed-postgres',
    });
    await expect(
      createPlatformInstallPlan(
        fake,
        { ...input, externalHyperdrive: { ...externalHyperdrive, id: 'other' } },
        null,
      ),
    ).rejects.toThrow('must exist');
    await expect(
      createPlatformInstallPlan(
        fake,
        { ...input, externalHyperdrive: { ...externalHyperdrive, name: 'renamed-config' } },
        null,
      ),
    ).rejects.toThrow('selected name');
    await expect(
      createPlatformInstallPlan(
        client({
          listHyperdriveConfigs: async () => [{ id: 'terraform-id', name: 'renamed-config' }],
        }),
        input,
        recorded,
      ),
    ).rejects.toThrow('selected name');
  });
  it.each(['install', 'upgrade'] as const)(
    'rejects incomplete shared email settings during %s',
    async (mode) => {
      const existing = mode === 'upgrade' ? legacyInstallation() : null;
      for (const emailSettings of [
        { emailSharedZoneId: 'mail-zone-id' },
        { emailSenderDomain: 'mail.example.org' },
      ]) {
        await expect(
          createPlatformInstallPlan(client(), { ...input, ...emailSettings }, existing),
        ).rejects.toThrow('VOID_EMAIL_SENDER_DOMAIN and VOID_EMAIL_SHARED_ZONE_ID together');
      }
    },
  );

  it('persists the shared email zone separately from the application zone on resume', async () => {
    const configured = await createPlatformInstallPlan(
      client(),
      { ...input, emailSharedZoneId: 'mail-zone-id', emailSenderDomain: 'mail.example.org' },
      null,
    );
    expect(configured.deployment.emailSharedZoneId).toBe('mail-zone-id');
    expect(configured.deployment.emailSenderDomain).toBe('mail.example.org');
    expect(configured.deployment.capabilities.email).toBe(true);
    const manifest = manifestFor(configured, '2026-09-17T00:00:00.000Z');
    const resumed = await createPlatformInstallPlan(client(), input, manifest);
    expect(resumed.deployment.emailSharedZoneId).toBe('mail-zone-id');
    expect(resumed.deployment.emailSenderDomain).toBe('mail.example.org');
    expect(resumed.deployment.capabilities.email).toBe(true);
    expect(resumed.zone?.id).not.toBe('mail-zone-id');
    await expect(
      createPlatformInstallPlan(
        client(),
        { ...input, emailSharedZoneId: 'different-zone' },
        manifest,
      ),
    ).rejects.toThrow('shared email zone is already recorded');
  });

  it('requires shared ingress identity before upgrading an email-enabled installation', async () => {
    const existing = legacyInstallation();
    const enabled = {
      ...existing,
      deployment: createPlatformDeploymentManifest({
        ...existing.deployment,
        capabilities: { ...existing.deployment.capabilities, email: true },
      }),
    };
    const listWorkerNames = vi.fn(async () => []);
    await expect(
      createPlatformInstallPlan(client({ listWorkerNames }), input, enabled, {
        includeEmailGateway: true,
      }),
    ).rejects.toThrow('VOID_EMAIL_SENDER_DOMAIN and VOID_EMAIL_SHARED_ZONE_ID');
    expect(listWorkerNames).not.toHaveBeenCalled();

    const configured = await createPlatformInstallPlan(
      client(),
      { ...input, emailSharedZoneId: 'mail-zone-id', emailSenderDomain: 'mail.example.org' },
      enabled,
      { includeEmailGateway: true },
    );
    expect(configured.deployment).toMatchObject({
      capabilities: { email: true },
      emailSharedZoneId: 'mail-zone-id',
      emailSenderDomain: 'mail.example.org',
    });
    expect(configured.actions).toContainEqual(
      expect.objectContaining({ key: 'email-gateway-worker' }),
    );
  });

  it('canonicalizes a trailing-dot sender domain before fresh-install resume checks', async () => {
    const configuredInput = {
      ...input,
      emailSharedZoneId: 'mail-zone-id',
      emailSenderDomain: 'Mail.Example.Org.',
    };
    const configured = await createPlatformInstallPlan(client(), configuredInput, null);
    expect(configured.deployment.emailSenderDomain).toBe('mail.example.org');
    const manifest = manifestFor(configured, '2026-09-17T00:00:00.000Z');

    const resumed = await createPlatformInstallPlan(client(), configuredInput, manifest);
    expect(resumed.deployment.emailSenderDomain).toBe('mail.example.org');
  });

  it('adds a configured shared email zone to a previously unconfigured installation', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    const manifest = manifestFor(initial, '2026-09-17T00:00:00.000Z');
    const upgraded = await createPlatformInstallPlan(
      client(),
      { ...input, emailSharedZoneId: 'mail-zone-id', emailSenderDomain: 'mail.example.org' },
      manifest,
    );
    expect(upgraded.deployment.emailSharedZoneId).toBe('mail-zone-id');
    expect(upgraded.deployment.emailSenderDomain).toBe('mail.example.org');
    expect(upgraded.deployment.capabilities.email).toBe(true);
    await expect(
      createPlatformInstallPlan(
        client(),
        { ...input, emailSenderDomain: 'other.example.org' },
        manifestFor(upgraded, '2026-09-17T00:00:00.000Z'),
      ),
    ).rejects.toThrow('already recorded');
  });

  it('records shared email settings without enabling an older runtime', async () => {
    const configured = await createPlatformInstallPlan(
      client(),
      { ...input, emailSharedZoneId: 'mail-zone-id', emailSenderDomain: 'mail.example.org' },
      null,
      { includeEmailGateway: false },
    );
    expect(configured.deployment.emailSharedZoneId).toBe('mail-zone-id');
    expect(configured.deployment.emailSenderDomain).toBe('mail.example.org');
    expect(configured.deployment.capabilities.email).toBe(false);
    expect(configured.actions).not.toContainEqual(
      expect.objectContaining({ key: 'email-gateway-worker' }),
    );
  });

  it('enables managed Sandbox for current installs and upgrades without adding a resource action', async () => {
    const legacy = legacyInstallation();
    expect(legacy.deployment.capabilities.sandbox).toBe(false);
    const upgraded = await createPlatformInstallPlan(client(), input, legacy, {
      enableSandbox: true,
    });
    expect(upgraded.deployment.capabilities.sandbox).toBe(true);
    expect(upgraded.actions.map((action) => action.key)).toEqual(
      expect.not.arrayContaining([expect.stringContaining('sandbox')]),
    );

    const fresh = await createPlatformInstallPlan(client(), input, null, {
      enableSandbox: true,
    });
    expect(fresh.deployment.capabilities.sandbox).toBe(true);
  });

  it('resumes the recorded namespaces using the real unfiltered KV API response', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    let manifest = manifestFor(initial, '2026-09-17T00:00:00.000Z');
    for (const [key, name] of [
      ['routing-kv', initial.deployment.resources.routingKv],
      ['isr-cache-kv', initial.deployment.resources.isrCacheKv],
      ['legacy-assets-kv', initial.deployment.resources.legacyAssetsKv],
    ]) {
      manifest = recordInstallationResource(
        manifest,
        {
          key,
          id: `${key}-id`,
          name,
          kind: 'kv-namespace',
          ownership: 'created',
          state: 'ready',
          configHash: 'test',
        },
        '2026-09-17T00:00:00.000Z',
      );
    }
    const entries = manifest.resources.map(({ id, name }) => ({ id, title: name }));
    const api = new PlatformCloudflareClient('test-token', {
      fetcher: async (url, init) => {
        expect(String(url)).toContain('/storage/kv/namespaces?');
        expect(init?.method ?? 'GET').toBe('GET');
        return Response.json({ success: true, result: entries });
      },
    });
    const inspected: Array<string> = [];
    const plannerClient = client({
      listKvNamespaces: api.listKvNamespaces.bind(api),
      getKvValue: async (_account: string, id: string) => {
        inspected.push(id);
        return id === 'routing-kv-id' ? JSON.stringify(manifest) : null;
      },
    });
    const resumed = await createPlatformInstallPlan(plannerClient, input, manifest);
    expect(inspected).toEqual(['routing-kv-id']);
    expect(resumed.actions.filter((action) => action.kind === 'kv-namespace')).toEqual(
      expect.arrayContaining(
        manifest.resources.map((resource) =>
          expect.objectContaining({
            action: 'reuse',
            id: resource.id,
            name: resource.name,
          }),
        ),
      ),
    );
    entries.push({ id: 'unowned-duplicate', title: initial.deployment.resources.routingKv });
    await expect(createPlatformInstallPlan(plannerClient, input, manifest)).rejects.toThrow(
      'More than one kv-namespace',
    );
  });

  it.each([false, true])(
    'bolds names and labels, not account IDs or URLs (workers.dev: %s)',
    async (workersDev) => {
      const plan = await createPlatformInstallPlan(
        client(),
        {
          ...input,
          ...(workersDev ? { workersDev: true, applicationDomain: '', zoneName: '' } : {}),
        },
        null,
      );
      const bold = vi.spyOn(pc, 'bold').mockImplementation(pc.createColors(true).bold);
      try {
        const output = formatPlatformInstallPlan(plan);
        expect(output).not.toMatch(/[();]/);
        expect(output.split('\n').slice(0, 5)).toEqual([
          '\u001b[1mExample in Account\u001b[22m',
          '\u001b[1mAccount:\u001b[22m account',
          '\u001b[1mApplications:\u001b[22m ' +
            (workersDev
              ? 'workers.dev for testing. Add a domain with void platform domain set <domain>'
              : '*.example.app'),
          `\u001b[1mControl plane:\u001b[22m ${plan.apiUrl}`,
          `\u001b[1mResource proxy:\u001b[22m ${plan.proxyUrl}`,
        ]);
        expect(output).toContain(
          `\u001b[1mLogin methods:\u001b[22m ${plan.deployment.authentication.providers.join(', ')}`,
        );
        expect(output).toContain('\u001b[1mAccess protection:\u001b[22m Not enabled');
        expect(output).toContain(`\u001b[1mLogin callback:\u001b[22m ${plan.apiUrl}/auth/callback`);
        expect(output).toContain(
          `\u001b[1mDatabase:\u001b[22m PostgreSQL via Hyperdrive ${plan.deployment.resources.hyperdrive}`,
        );
        expect(output).not.toContain('Access login:');
        expect(output).not.toContain('Access protection: verify');
      } finally {
        bold.mockRestore();
      }
    },
  );

  it('keeps an explicit pending AI Gateway check in previews, then verifies it without changing resource names', async () => {
    const denied = client({
      listAiGateways: async () => {
        throw new PlatformCloudflareApiError(
          'Authentication error',
          403,
          '/accounts/account/ai-gateway/gateways',
        );
      },
    });
    const preview = await createPlatformInstallPlan(denied, input, null, {
      allowUnverifiedAiGateway: true,
    });
    expect(preview.actions.find((action) => action.key === 'ai-gateway')).toMatchObject({
      action: 'inspect',
      reason: expect.stringContaining('AI Gateway: Edit'),
    });
    const output = formatPlatformInstallPlan(preview);
    expect(output).toMatch(/^inspect\s+ai-gateway\s+void-example$/m);
    expect(output).not.toContain('AI Gateway access will be verified');
    await expect(installPlatform(preview, {} as never, null, {} as never)).rejects.toThrow(
      'verified before provisioning',
    );
    const verified = await verifyPlatformAiGatewayPlan(client(), input, null, preview, false);
    expect(verified.actions.find((action) => action.key === 'ai-gateway')?.action).toBe('create');
    expect(verified.deployment).toEqual(preview.deployment);
    expect(verified.installationId).toBe(preview.installationId);
    await expect(verifyPlatformAiGatewayPlan(denied, input, null, preview, false)).rejects.toThrow(
      'runtime token could not verify AI Gateway',
    );
  });

  it('does not conceal other permission failures or AI Gateway service errors in previews', async () => {
    await expect(
      createPlatformInstallPlan(
        client({
          listAiGateways: async () => {
            throw new PlatformCloudflareApiError('service unavailable', 503);
          },
        }),
        input,
        null,
        { allowUnverifiedAiGateway: true },
      ),
    ).rejects.toThrow('service unavailable');
    await expect(
      createPlatformInstallPlan(
        client({
          listKvNamespaces: async () => {
            throw new PlatformCloudflareApiError('KV access denied', 403);
          },
        }),
        input,
        null,
        { allowUnverifiedAiGateway: true },
      ),
    ).rejects.toThrow('KV access denied');
  });

  it('reports both unpaid-account prerequisites from the existing read-only inventory', async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const provider = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, method: init?.method ?? 'GET' });
        const code = path.endsWith('/r2/buckets') ? 10042 : 10121;
        return Response.json(
          { success: false, errors: [{ code, message: 'Account prerequisite missing' }] },
          { status: 403 },
        );
      },
    });
    const error = await createPlatformInstallPlan(
      client({
        listR2Buckets: provider.listR2Buckets.bind(provider),
        listDispatchNamespaces: provider.listDispatchNamespaces.bind(provider),
      }),
      input,
      null,
    ).catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toContain('Cloudflare R2 is not enabled');
    expect(error.message).toContain('Workers for Platforms requires a paid subscription');
    expect(error.message).toContain('retry the same command');
    expect(error.message).not.toContain('--resume');
    expect(error.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 403, requestPath: '/accounts/account/r2/buckets' }),
        expect.objectContaining({
          status: 403,
          requestPath: '/accounts/account/workers/dispatch/namespaces',
        }),
      ]),
    );
    expect(error.errors).toHaveLength(2);
    expect(requests).toEqual([
      { path: '/client/v4/accounts/account/r2/buckets', method: 'GET' },
      { path: '/client/v4/accounts/account/workers/dispatch/namespaces', method: 'GET' },
    ]);
  });

  it.each([401, 403, 500])(
    'does not replace an HTTP %s inventory failure with a known prerequisite',
    async (status) => {
      const unknown = new PlatformCloudflareApiError(
        'Unrelated provider failure',
        status,
        '/accounts/account/workers/dispatch/namespaces',
      );
      const provider = new PlatformCloudflareClient('token', {
        fetcher: async () =>
          Response.json(
            { success: false, errors: [{ code: 10042, message: 'Please enable R2' }] },
            { status: 403 },
          ),
      });
      await expect(
        createPlatformInstallPlan(
          client({
            listR2Buckets: provider.listR2Buckets.bind(provider),
            listDispatchNamespaces: async () => {
              await Promise.resolve();
              throw unknown;
            },
          }),
          input,
          null,
        ),
      ).rejects.toBe(unknown);
    },
  );

  it('names the DNS permission when the token cannot read DNS records', async () => {
    const deniedDns = async () => {
      throw new PlatformCloudflareApiError('Authentication error', 403, '/zones/zone/dns_records');
    };
    const wildcard = createPlatformInstallPlan(
      client({ findZone: async () => activeZone, listDnsRecords: deniedDns }),
      input,
      null,
    );
    await expect(wildcard).rejects.toThrow(
      'platform: Cloudflare denied reading DNS records for example.app (HTTP 403). Add Zone → DNS → Edit for this zone to the management token, then rerun.',
    );
    await expect(wildcard).rejects.not.toThrow('Authentication error');

    const apiHostname = createPlatformInstallPlan(
      client({ findZoneForHostname: async () => activeZone, listDnsRecords: deniedDns }),
      { ...input, controlPlaneDomain: 'api.example.app' },
      null,
    );
    await expect(apiHostname).rejects.toThrow('Zone → DNS → Edit');
    await expect(apiHostname).rejects.not.toThrow('Authentication error');

    await expect(
      createPlatformInstallPlan(
        client({
          findZone: async () => activeZone,
          listDnsRecords: async () => {
            throw new PlatformCloudflareApiError('service unavailable', 503);
          },
        }),
        input,
        null,
      ),
    ).rejects.toThrow('service unavailable');
  });
  it('plans workers.dev without any zone, DNS, or certificate access', async () => {
    const forbidden = async () => {
      throw new Error('zone access must not occur');
    };
    const plan = await createPlatformInstallPlan(
      client({
        findZone: forbidden,
        listDnsRecords: forbidden,
        listWorkerRoutes: forbidden,
        listWorkerDomains: forbidden,
        hasActiveCertificateForHostname: forbidden,
      }),
      { ...input, applicationDomain: '', zoneName: '', workersDev: true },
      null,
    );
    expect(plan.zone).toBeNull();
    expect(
      plan.actions.some((action) => action.kind === 'zone' || action.kind === 'dns-record'),
    ).toBe(false);
    expect(plan.deployment.application).toMatchObject({
      baseDomain: 'example.workers.dev',
      zoneName: '',
      workersDev: { subdomain: 'example' },
    });
    expect(plan.actions.filter((action) => action.kind === 'worker')).toHaveLength(5);
  });
  it('rejects an uncovered nested application domain before resource inventory', async () => {
    let inventoried = false;
    const zone = { id: 'zone', name: 'example.com', nameServers: [], status: 'active' };
    const fake = client({
      findZone: async () => zone,
      hasActiveCertificateForHostname: async (_zone: string, hostname: string) => {
        expect(hostname).toBe('*.apps.example.com');
        return false;
      },
      listWorkerNames: async () => {
        inventoried = true;
        return [];
      },
    });
    const nested = { ...input, applicationDomain: 'apps.example.com', zoneName: 'example.com' };
    await expect(createPlatformInstallPlan(fake, nested, null)).rejects.toThrow(
      'No active edge certificate',
    );
    expect(inventoried).toBe(false);
    await expect(createPlatformInstallPlan(client(), nested, null)).rejects.toThrow(
      'needs an active zone',
    );
  });

  it('keeps valid nested-domain platforms and explains missing certificate permissions', async () => {
    const nested = { ...input, applicationDomain: 'apps.example.com', zoneName: 'example.com' };
    const zone = { id: 'zone', name: 'example.com', nameServers: [], status: 'active' };
    const plan = await createPlatformInstallPlan(
      client({ findZone: async () => zone }),
      nested,
      null,
    );
    expect(plan.deployment.application.baseDomain).toBe('apps.example.com');
    await expect(
      createPlatformInstallPlan(
        client({
          findZone: async () => zone,
          hasActiveCertificateForHostname: async () => {
            throw new Error('permission denied');
          },
        }),
        nested,
        null,
      ),
    ).rejects.toThrow('SSL and Certificates > Read');
  });

  it('does not probe certificate products for zone-apex application domains', async () => {
    const plan = await createPlatformInstallPlan(
      client({
        hasActiveCertificateForHostname: async () => {
          throw new Error('must not probe');
        },
      }),
      input,
      null,
    );
    expect(plan.deployment.application.baseDomain).toBe(plan.deployment.application.zoneName);
  });

  it.each(['oauth-access-token', 'account-api-token'])(
    'plans using authorized accounts for %s',
    async (token) => {
      const requests: Array<string> = [];
      const remote = new PlatformCloudflareClient(token, {
        apiBase: 'https://cloudflare.example.test/client/v4',
        fetcher: async (url, init) => {
          requests.push(String(url));
          expect(init?.method ?? 'GET').toBe('GET');
          // These valid credential kinds cannot use the user API-token endpoint.
          if (String(url).includes('/user/tokens/verify')) {
            return Response.json(
              { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] },
              { status: 401 },
            );
          }
          expect(String(url)).toContain('/accounts?');
          return Response.json({ success: true, result: [{ id: 'account', name: 'Account' }] });
        },
      });
      const fake = Object.assign(
        remote,
        Object.fromEntries(Object.entries(client()).filter(([name]) => name !== 'listAccounts')),
      );
      const plan = await createPlatformInstallPlan(fake, input, null);
      expect(plan.account.id).toBe('account');
      expect(requests).toHaveLength(1);
      expect(requests.every((url) => url.includes('/accounts?'))).toBe(true);
    },
  );

  it('rejects credentials without account access before planning resources', async () => {
    const remote = new PlatformCloudflareClient('expired-token', {
      apiBase: 'https://cloudflare.example.test/client/v4',
      fetcher: async (url) => {
        expect(String(url)).toContain('/accounts?');
        return Response.json(
          { success: false, errors: [{ message: 'invalid credentials' }] },
          { status: 401 },
        );
      },
    });
    const fake = Object.assign(
      remote,
      Object.fromEntries(Object.entries(client()).filter(([name]) => name !== 'listAccounts')),
    );
    fake.getWorkersSubdomain = async () => {
      throw new Error('resource access must not run');
    };
    await expect(createPlatformInstallPlan(fake, input, null)).rejects.toThrow(
      'invalid credentials',
    );
  });

  it('builds a read-only core plan without containers', async () => {
    const fake = client();
    const plan = await createPlatformInstallPlan(fake, input, null);
    expect(plan.apiUrl).toBe(`https://${plan.deployment.resources.apiWorker}.example.workers.dev`);
    expect(plan.deployment.resources.apiWorker).toBe('void-example-api');
    expect(plan.actions).toHaveLength(16);
    expect(plan.actions.every((action) => action.action === 'create')).toBe(true);
  });

  it('keeps a fresh read-only plan stable for the later apply', async () => {
    const planned = await createPlatformInstallPlan(client(), input, null);
    const applied = await createPlatformInstallPlan(client(), input, null);
    expect(applied.installationId).toBe(planned.installationId);
    expect(applied.apiUrl).toBe(planned.apiUrl);
    expect(applied.deployment.resources).toEqual(planned.deployment.resources);
  });

  it.each(['a', 'example', 'void-e2e', 'abcdef-team', 'x'.repeat(40)])(
    'uses the full readable name without a resource suffix for %s',
    async (installationSlug) => {
      for (const workersDev of [false, true]) {
        const plan = await createPlatformInstallPlan(
          client(),
          {
            ...input,
            installationSlug,
            ...(workersDev ? { workersDev: true, applicationDomain: '', zoneName: '' } : {}),
          },
          null,
        );
        expect(plan.deployment.installationSlug).toBe(installationSlug);
        expect(plan.deployment.resources.apiWorker).toBe(`void-${installationSlug}-api`);
        for (const name of Object.values(plan.deployment.resources)) {
          expect(name.length).toBeLessThanOrEqual(63);
          expect(name).not.toContain('--');
        }
      }
    },
  );

  it.each(['0123456789ab', '0123456789abcdef0123456789abcdef'])(
    'preserves recorded resource names from installations with the suffix %s',
    async (suffix) => {
      const existing = legacyInstallation(suffix);
      const plan = await createPlatformInstallPlan(client(), input, existing);
      expect(plan.deployment.resources).toEqual(existing.deployment.resources);
      expect(plan.apiUrl).toBe(`https://void-example-${suffix}-api.example.workers.dev`);
    },
  );

  it.each([
    {
      listKvNamespaces: async (_account: string, title: string) =>
        title.endsWith('-routing') ? [{ id: 'someone-else', name: title }] : [],
    },
    { listWorkerNames: async () => ['void-example-api'] },
    { listR2Buckets: async () => [{ id: 'void-example-assets', name: 'void-example-assets' }] },
    { listQueues: async (_account: string, name: string) => [{ id: 'other-queue', name }] },
  ])('refuses existing account resources instead of allocating another name', async (inventory) => {
    await expect(createPlatformInstallPlan(client(inventory), input, null)).rejects.toThrow(
      'Resume the owning installation, or choose another installation name. Nothing was overwritten.',
    );
  });

  it('stops on unverified ownership for a readable resource rather than renaming it', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    const name = initial.deployment.resources.assetsBucket;
    const fingerprint = '2026-09-14T00:00:00.000Z';
    const manifest = recordInstallationResource(
      manifestFor(initial, fingerprint),
      {
        configHash: r2ConfigHash(name, fingerprint),
        id: name,
        key: 'assets-bucket',
        kind: 'r2-bucket',
        name,
        ownership: 'created',
        state: 'ready',
      },
      fingerprint,
    );
    await expect(
      createPlatformInstallPlan(
        client({ listR2Buckets: async () => [{ fingerprint, id: name, name }] }),
        input,
        manifest,
      ),
    ).rejects.toThrow('The resource was left untouched.');
    expect(manifest.deployment.resources.assetsBucket).toBe('void-example-assets');
  });

  it('refuses to replace an existing Worker custom domain or DNS record', async () => {
    const customInput = { ...input, controlPlaneDomain: 'api.platform.example.com' };
    await expect(
      createPlatformInstallPlan(
        client({
          listWorkerDomains: async () => [
            { hostname: customInput.controlPlaneDomain, id: 'domain', service: 'other-worker' },
          ],
        }),
        customInput,
        null,
      ),
    ).rejects.toThrow('already assigned');

    await expect(
      createPlatformInstallPlan(
        client({
          findZoneForHostname: async () => ({
            id: 'control-zone',
            name: 'example.com',
            nameServers: [],
            status: 'active',
          }),
          listDnsRecords: async (_zone: string, name: string) =>
            name === customInput.controlPlaneDomain
              ? [
                  {
                    content: '192.0.2.1',
                    id: 'existing-dns',
                    name,
                    proxied: true,
                    type: 'A',
                  },
                ]
              : [],
        }),
        customInput,
        null,
      ),
    ).rejects.toThrow('already has a DNS record');
  });

  it('refuses to take over an existing application Worker route', async () => {
    await expect(
      createPlatformInstallPlan(
        client({
          findZone: async () => activeZone,
          listWorkerRoutes: async () => [
            { id: 'route', pattern: '*.example.app/*', script: 'other-worker' },
          ],
        }),
        input,
        null,
      ),
    ).rejects.toThrow('Application route');
  });

  it.each(['fresh install', 'upgrade', 'domain set'])(
    'preserves unrelated Worker custom domains during %s',
    async (operation) => {
      let existing = operation === 'upgrade' ? legacyInstallation() : null;
      if (operation === 'domain set') {
        const initial = await createPlatformInstallPlan(
          client(),
          { ...input, applicationDomain: '', zoneName: '', workersDev: true },
          null,
        );
        const manifest = {
          ...manifestFor(initial),
          status: 'installed' as const,
        };
        existing = {
          ...manifest,
          deployment: createPlatformDeploymentManifest({
            ...manifest.deployment,
            application: platformDomainTarget(manifest, 'example.app', 'example.app', false),
          }),
        };
      }
      await expect(
        createPlatformInstallPlan(
          client({
            findZone: async () => activeZone,
            listWorkerDomains: async () => [
              { hostname: 'ai.example.app', id: 'custom-domain', service: 'existing-ai' },
            ],
          }),
          input,
          existing,
        ),
      ).rejects.toThrow(
        'would intercept Worker custom domain "ai.example.app", currently served by "existing-ai". Choose another application domain, or use `void platform install --workers-dev`',
      );
    },
  );

  it.each([
    {
      hostname: 'ai.example.app',
      routes: [{ pattern: 'ai.example.app/*', script: 'existing-ai' }],
    },
    { hostname: 'ai.example.app', routes: [{ pattern: 'ai.example.app/*', script: null }] },
    {
      hostname: 'ai.example.app',
      routes: [
        { pattern: 'http://ai.example.app/*', script: null },
        { pattern: 'https://ai.example.app/*', script: 'existing-ai' },
      ],
    },
    {
      hostname: 'ai.services.example.app',
      routes: [{ pattern: '*.services.example.app/*', script: 'existing-ai' }],
    },
  ])(
    'preserves custom domains protected by more-specific routes: $routes',
    async ({ hostname, routes }) => {
      const plan = await createPlatformInstallPlan(
        client({
          findZone: async () => activeZone,
          listWorkerDomains: async () => [
            { hostname, id: 'custom-domain', service: 'existing-ai' },
          ],
          listWorkerRoutes: async () =>
            routes.map((route, index) => ({ ...route, id: `${index}` })),
        }),
        input,
        null,
      );
      expect(plan.deployment.application.baseDomain).toBe('example.app');
    },
  );

  it.each([
    { pattern: 'ai.example.app', script: 'existing-ai' },
    { pattern: 'ai.example.app/', script: null },
    { pattern: 'ai.example.app/api/*', script: 'existing-ai' },
    { pattern: 'https://ai.example.app/*', script: 'existing-ai' },
    { pattern: 'ai.example.app/*', script: 'void-example-dispatch' },
  ])('rejects routes that leave custom-domain traffic exposed: $pattern', async (route) => {
    await expect(
      createPlatformInstallPlan(
        client({
          findZone: async () => activeZone,
          listWorkerDomains: async () => [
            { hostname: 'ai.example.app', id: 'custom-domain', service: 'existing-ai' },
          ],
          listWorkerRoutes: async () => [{ ...route, id: 'existing-route' }],
        }),
        input,
        null,
      ),
    ).rejects.toThrow('would intercept Worker custom domain');
  });

  it('leaves apex and other application namespaces outside a shared-zone wildcard', async () => {
    const plan = await createPlatformInstallPlan(
      client({
        findZone: async () => activeZone,
        listWorkerDomains: async () => [
          { hostname: 'example.app', id: 'apex', service: 'existing-apex' },
          {
            hostname: 'ai.other.app',
            id: 'other-zone',
            service: 'existing-ai',
            zoneName: 'other.app',
          },
        ],
      }),
      input,
      null,
    );
    expect(plan.deployment.application.dedicatedZone).toBe(false);
    const nested = await createPlatformInstallPlan(
      client({
        findZone: async () => activeZone,
        listWorkerDomains: async () => [
          { hostname: 'ai.example.app', id: 'existing-ai', service: 'existing-ai' },
          { hostname: 'apps.example.app', id: 'application-apex', service: 'existing-apps' },
        ],
      }),
      { ...input, applicationDomain: 'apps.example.app' },
      null,
    );
    expect(nested.deployment.application.baseDomain).toBe('apps.example.app');
  });

  it('preserves unrelated apex custom domains against dedicated-zone catch-all routes', async () => {
    await expect(
      createPlatformInstallPlan(
        client({
          findZone: async () => activeZone,
          listWorkerDomains: async () => [
            { hostname: 'example.app', id: 'apex', service: 'existing-apex' },
          ],
        }),
        { ...input, dedicatedZone: true },
        null,
      ),
    ).rejects.toThrow('Application route "*/*" would intercept Worker custom domain "example.app"');
  });

  it('does not infer custom-domain ownership from a matching new dispatch Worker name', async () => {
    await expect(
      createPlatformInstallPlan(
        client({
          findZone: async () => activeZone,
          listWorkerDomains: async () => [
            { hostname: 'ai.example.app', id: 'custom-domain', service: 'void-example-dispatch' },
          ],
        }),
        input,
        null,
      ),
    ).rejects.toThrow('would intercept Worker custom domain');
  });

  it('preserves custom-domain origins owned by a recorded legacy dispatch Worker', async () => {
    const original = legacyInstallation();
    const workerName = original.deployment.resources.dispatchWorker;
    const manifest = recordInstallationResource(
      original,
      {
        configHash: 'legacy-worker-config',
        id: workerName,
        key: 'dispatch-worker',
        kind: 'worker',
        name: workerName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const plan = await createPlatformInstallPlan(
      client({
        findZone: async () => activeZone,
        listWorkerDomains: async () => [
          { hostname: 'owned.example.app', id: 'custom-domain', service: workerName },
        ],
        listWorkerNames: async () => [workerName],
      }),
      input,
      manifest,
    );
    expect(plan.deployment.resources.dispatchWorker).toBe(workerName);
    expect(plan.actions.find((action) => action.key === 'dispatch-worker')).toMatchObject({
      action: 'update',
      id: workerName,
    });
  });

  it('refuses a same-named AI Gateway after an interrupted create', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    const action = initial.actions.find((entry) => entry.key === 'ai-gateway')!;
    const name = action.name;
    const manifest = recordProvisionIntent(
      manifestFor(initial),
      action,
      '2026-09-14T00:00:01.000Z',
    );
    // Gateways carry no ownership marker, so a creation time just after the
    // intent does not show who created this one.
    const withGateway = client({
      listAiGateways: async () => [{ createdAt: '2026-09-14T00:00:03.000Z', id: name, name }],
    });

    await expect(createPlatformInstallPlan(withGateway, input, manifest)).rejects.toThrow(
      `platform: ai-gateway "${name}" already exists, and Void cannot tell whether this installation created it. Nothing was overwritten. If an earlier failed attempt of this installation created it, delete it in the Cloudflare dashboard, then rerun the command. Otherwise, choose another installation name.`,
    );
    await expect(createPlatformInstallPlan(withGateway, input, null)).rejects.toThrow(
      'Resume the owning installation, or choose another installation name.',
    );
  });

  it('refuses an intent-only resource after an ambiguous create response', async () => {
    const initial = await createPlatformInstallPlan(client(), input, legacyInstallation());
    let manifest = manifestFor(initial);
    const resourceName = initial.deployment.resources.routingKv;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'provision-intent:routing-kv',
        resultHash: platformProvisionIntentHash(
          manifest,
          'routing-kv',
          'kv-namespace',
          resourceName,
        ),
      },
      '2026-09-14T00:00:01.000Z',
    );

    await expect(
      createPlatformInstallPlan(
        client({
          listKvNamespaces: async (_account: string, title: string) =>
            title === resourceName ? [{ id: 'created-before-crash', name: title }] : [],
        }),
        input,
        manifest,
      ),
    ).rejects.toThrow('cannot tell whether this installation created it');

    const recovered = await createPlatformInstallPlan(
      client({
        listKvNamespaces: async (_account: string, title: string) =>
          title === resourceName ? [{ id: 'created-before-crash', name: title }] : [],
      }),
      input,
      manifest,
      { authoritativeProvisionIntents: true },
    );
    const retry = recovered.actions.find((action) => action.key === 'routing-kv');
    expect(retry).toMatchObject({
      action: 'create',
      id: null,
      reason:
        'Leave the ambiguous same-name resource untouched and create a fresh installer-scoped replacement.',
    });
    expect(retry?.name).not.toBe(resourceName);
    expect(recovered.deployment.resources.routingKv).toBe(retry?.name);
  });

  it('preserves legacy recovery after an interrupted repair create', async () => {
    const initial = await createPlatformInstallPlan(client(), input, legacyInstallation());
    const resourceName = initial.deployment.resources.routingKv;
    let manifest = manifestFor(initial);
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'old',
        id: 'missing-old-id',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: resourceName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const resultHash = platformProvisionIntentHash(
      manifest,
      'routing-kv',
      'kv-namespace',
      resourceName,
      'missing-old-id',
    );
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:02.000Z',
        key: `provision-intent:routing-kv:${resultHash.slice(0, 16)}`,
        resultHash,
      },
      '2026-09-14T00:00:02.000Z',
    );

    const resumed = await createPlatformInstallPlan(
      client({
        listKvNamespaces: async (_account: string, title: string) =>
          title === resourceName ? [{ id: 'replacement-before-crash', name: title }] : [],
      }),
      input,
      manifest,
      { authoritativeProvisionIntents: true, repairMissing: true },
    );
    const retry = resumed.actions.find((action) => action.key === 'routing-kv');
    expect(retry).toMatchObject({ action: 'create', id: null });
    expect(retry?.name).not.toBe(resourceName);
  });

  it('retains a recorded R2 bucket whose ownership marker is missing', async () => {
    const initial = await createPlatformInstallPlan(client(), input, legacyInstallation());
    const bucketName = initial.deployment.resources.assetsBucket;
    const fingerprint = '2026-09-14T00:00:00.000Z';
    let manifest = manifestFor(initial, fingerprint);
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: r2ConfigHash(bucketName, fingerprint),
        id: bucketName,
        key: 'assets-bucket',
        kind: 'r2-bucket',
        name: bucketName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );

    const resumed = await createPlatformInstallPlan(
      client({
        listR2Buckets: async () => [{ fingerprint, id: bucketName, name: bucketName }],
      }),
      input,
      manifest,
    );
    const replacement = resumed.actions.find((action) => action.key === 'assets-bucket');
    expect(replacement).toMatchObject({
      action: 'create',
      id: null,
      reason:
        'Retain the ambiguously owned resource and create a fresh installer-scoped replacement.',
    });
    expect(replacement?.name).toMatch(/-retry-[a-f0-9]{32}$/);
    expect(resumed.deployment.resources.assetsBucket).toBe(replacement?.name);
  });

  it('retains a marked R2 bucket whose creation fingerprint changed', async () => {
    const initial = await createPlatformInstallPlan(client(), input, legacyInstallation());
    const bucketName = initial.deployment.resources.assetsBucket;
    const fingerprint = '2026-09-14T00:00:00.000Z';
    let manifest = manifestFor(initial, fingerprint);
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: r2ConfigHash(bucketName, fingerprint),
        id: bucketName,
        key: 'assets-bucket',
        kind: 'r2-bucket',
        name: bucketName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = markerFor(manifest, 'assets-bucket', 'r2-bucket', bucketName);

    const resumed = await createPlatformInstallPlan(
      client({
        getR2Object: async () => marker,
        listR2Buckets: async () => [
          { fingerprint: '2026-09-14T00:00:02.000Z', id: bucketName, name: bucketName },
        ],
      }),
      input,
      manifest,
    );
    expect(resumed.actions.find((action) => action.key === 'assets-bucket')).toMatchObject({
      action: 'create',
      id: null,
    });
  });

  it('recovers only an intent-only Worker with its matching durable marker', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    let manifest = manifestFor(initial);
    const workerName = manifest.deployment.resources.apiWorker;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'provision-intent:api-worker',
        resultHash: platformProvisionIntentHash(manifest, 'api-worker', 'worker', workerName),
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = markerFor(manifest, 'api-worker', 'worker', workerName);
    const resumed = await createPlatformInstallPlan(
      client({
        getWorkerPlainTextBindings: async () => ({ PLATFORM_OWNERSHIP_MARKER: marker }),
        listWorkerNames: async () => [workerName],
      }),
      input,
      manifest,
    );
    expect(resumed.actions.find((action) => action.key === 'api-worker')).toMatchObject({
      action: 'update',
      id: workerName,
    });

    await expect(
      createPlatformInstallPlan(
        client({
          getWorkerPlainTextBindings: async () => ({}),
          listWorkerNames: async () => [workerName],
        }),
        input,
        manifest,
      ),
    ).rejects.toThrow('cannot tell whether this installation created it');
  });

  it('resumes an intent-owned dispatch Worker after its public route was uploaded', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    let manifest = manifestFor(initial);
    const workerName = manifest.deployment.resources.dispatchWorker;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'provision-intent:dispatch-worker',
        resultHash: platformProvisionIntentHash(manifest, 'dispatch-worker', 'worker', workerName),
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = markerFor(manifest, 'dispatch-worker', 'worker', workerName);

    const resumed = await createPlatformInstallPlan(
      client({
        findZone: async () => activeZone,
        getWorkerPlainTextBindings: async () => ({ PLATFORM_OWNERSHIP_MARKER: marker }),
        listWorkerNames: async () => [workerName],
        listWorkerDomains: async () => [
          { hostname: 'owned.example.app', id: 'custom-domain', service: workerName },
        ],
        listWorkerRoutes: async () => [
          { id: 'route', pattern: '*.example.app/*', script: workerName },
        ],
      }),
      input,
      manifest,
    );

    expect(resumed.actions.find((action) => action.key === 'dispatch-worker')).toMatchObject({
      action: 'update',
      id: workerName,
    });
  });

  it('resumes an intent-owned API Worker after its custom domain was uploaded', async () => {
    const customInput = { ...input, controlPlaneDomain: 'api.platform.example.com' };
    const initial = await createPlatformInstallPlan(client(), customInput, null);
    let manifest = manifestFor(initial);
    const workerName = manifest.deployment.resources.apiWorker;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'provision-intent:api-worker',
        resultHash: platformProvisionIntentHash(manifest, 'api-worker', 'worker', workerName),
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = markerFor(manifest, 'api-worker', 'worker', workerName);

    const resumed = await createPlatformInstallPlan(
      client({
        findZoneForHostname: async () => ({
          id: 'control-zone',
          name: 'example.app',
          nameServers: [],
          status: 'active',
        }),
        getWorkerPlainTextBindings: async () => ({ PLATFORM_OWNERSHIP_MARKER: marker }),
        listDnsRecords: async (_zone: string, hostname: string) =>
          hostname === customInput.controlPlaneDomain
            ? [
                {
                  content: workerName,
                  id: 'custom-domain-dns',
                  name: hostname,
                  proxied: true,
                  type: 'CNAME',
                },
              ]
            : [],
        listWorkerDomains: async () => [
          { hostname: customInput.controlPlaneDomain, id: 'domain', service: workerName },
        ],
        listWorkerNames: async () => [workerName],
      }),
      customInput,
      manifest,
    );

    expect(resumed.actions.find((action) => action.key === 'api-worker')).toMatchObject({
      action: 'update',
      id: workerName,
    });
  });

  it('refuses to deploy over a Worker replaced after planning', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    let manifest = manifestFor(initial);
    const workerName = manifest.deployment.resources.apiWorker;
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: workerName,
        key: 'api-worker',
        kind: 'worker',
        name: workerName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const marker = markerFor(manifest, 'api-worker', 'worker', workerName);
    let liveMarker: string | undefined = marker;
    const fake = client({
      getWorkerPlainTextBindings: async () =>
        liveMarker ? { PLATFORM_OWNERSHIP_MARKER: liveMarker } : {},
      listWorkerNames: async () => [workerName],
    });
    const original = await createPlatformInstallPlan(fake, input, manifest);
    const action = original.actions.find((entry) => entry.key === 'api-worker')!;
    liveMarker = undefined;

    await expect(revalidatePlatformInstallAction(fake, original, manifest, action)).rejects.toThrow(
      "no longer has this installation's ownership marker",
    );
  });

  it('revalidates a stable upgrade Worker without rebuilding the platform plan', async () => {
    const initial = await createPlatformInstallPlan(client(), input, null);
    let manifest = manifestFor(initial);
    const workerName = manifest.deployment.resources.apiWorker;
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: workerName,
        key: 'api-worker',
        kind: 'worker',
        name: workerName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const action = {
      action: 'update',
      id: workerName,
      key: 'api-worker',
      kind: 'worker',
      name: workerName,
      reason: 'Update the owned Worker.',
    } as const;
    const stablePlan = { ...initial, actions: [action] };
    let marker = markerFor(manifest, action.key, 'worker', workerName);
    const listAccounts = vi.fn(async () => {
      throw new Error('full planning was called');
    });
    const fake = client({
      getWorkerPlainTextBindings: async () => ({ PLATFORM_OWNERSHIP_MARKER: marker }),
      listAccounts,
    });

    await expect(
      revalidatePlatformInstallAction(fake, stablePlan, manifest, action, {
        stableWorkerUpdate: true,
      }),
    ).resolves.toBeUndefined();
    expect(listAccounts).not.toHaveBeenCalled();

    marker = 'another installation';
    await expect(
      revalidatePlatformInstallAction(fake, stablePlan, manifest, action, {
        stableWorkerUpdate: true,
      }),
    ).rejects.toThrow("no longer has this installation's ownership marker");
    expect(listAccounts).not.toHaveBeenCalled();

    await expect(
      revalidatePlatformInstallAction(fake, initial, manifest, action, {
        stableWorkerUpdate: true,
      }),
    ).rejects.toThrow('full planning was called');
  });

  it('resumes resources proven by the remote ownership checkpoint', async () => {
    let manifest = defaultManifest();
    const local = manifest;
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'created-before-crash',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'void-example-routing',
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const plan = await createPlatformInstallPlan(
      client({
        getKvValue: async () => JSON.stringify(manifest),
        listKvNamespaces: async (_account: string, title: string) =>
          title === 'void-example-routing' ? [{ id: 'created-before-crash', name: title }] : [],
      }),
      input,
      local,
    );
    expect(plan.actions.find((action) => action.key === 'routing-kv')).toMatchObject({
      action: 'reuse',
      id: 'created-before-crash',
    });
  });

  it('adopts an existing zone without claiming ownership', async () => {
    const fake = client({
      findZone: async () => activeZone,
    });
    const plan = await createPlatformInstallPlan(fake, input, null);
    expect(plan.actions[0]).toMatchObject({ action: 'adopt', id: 'zone', kind: 'zone' });
  });

  it('adopts only a compatible wildcard application DNS record', async () => {
    const plan = await createPlatformInstallPlan(
      client({
        findZone: async () => activeZone,
        listDnsRecords: async () => [
          {
            content: '100::',
            id: 'dns',
            name: '*.example.app',
            proxied: true,
            type: 'AAAA',
          },
        ],
      }),
      input,
      null,
    );
    expect(plan.actions.find((action) => action.key === 'application-dns')).toMatchObject({
      action: 'adopt',
      id: 'dns',
    });

    await expect(
      createPlatformInstallPlan(
        client({
          findZone: async () => activeZone,
          listDnsRecords: async () => [
            {
              content: '192.0.2.1',
              id: 'dns',
              name: '*.example.app',
              proxied: false,
              type: 'A',
            },
          ],
        }),
        input,
        null,
      ),
    ).rejects.toThrow('unproxied record');
  });

  it('repairs a missing installer-owned resource', async () => {
    let manifest = defaultManifest();
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'missing-routing',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'void-example-routing',
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const plan = await createPlatformInstallPlan(client(), input, manifest, {
      repairMissing: true,
    });
    expect(plan.actions.find((action) => action.key === 'routing-kv')).toMatchObject({
      action: 'create',
      id: null,
    });
  });

  it('revalidates a missing Worker with the approved repair policy', async () => {
    let manifest = defaultManifest();
    const workerName = manifest.deployment.resources.apiWorker;
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: workerName,
        key: 'api-worker',
        kind: 'worker',
        name: workerName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const plan = await createPlatformInstallPlan(client(), input, manifest, {
      repairMissing: true,
    });
    const action = plan.actions.find((entry) => entry.key === 'api-worker')!;

    await expect(
      revalidatePlatformInstallAction(client(), plan, manifest, action, {
        repairMissing: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses to recreate a missing adopted resource', async () => {
    let manifest = defaultManifest();
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'external-routing',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'void-example-routing',
        ownership: 'adopted',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    await expect(
      createPlatformInstallPlan(client(), input, manifest, { repairMissing: true }),
    ).rejects.toThrow('will not recreate');
  });
});
