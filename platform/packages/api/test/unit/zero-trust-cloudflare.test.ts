import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  bypassPolicy,
  reusablePolicyReferences,
  ZeroTrustCloudflareClient,
} from '../../src/zero-trust/cloudflare.ts';

function envelope(result: unknown, status = 200): Response {
  return Response.json(
    status >= 400
      ? { success: false, errors: [{ message: 'not found' }] }
      : { success: true, result },
    { status },
  );
}

function applicationSpec(name: string) {
  return {
    name,
    destinations: ['project.apps.example.com'],
    policies: bypassPolicy('Public project'),
  };
}

function applicationFixture() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input.toString()).pathname;
    const policyId = path.match(/\/apps\/([^/]+)\/policies$/)?.[1];
    if (policyId && !init?.method) {
      return envelope(applications.get(policyId)?.policies ?? []);
    }
    const id = path.match(/\/apps\/([^/]+)$/)?.[1];
    if (path.endsWith('/apps') && !init?.method) {
      return envelope([...applications.values()]);
    }
    if (id && init?.method === 'DELETE') {
      return applications.delete(id) ? envelope({ id }) : envelope(null, 404);
    }
    if (init?.method === 'POST' || (id && init?.method === 'PUT')) {
      const appId = id ?? `app-${nextId++}`;
      const application = {
        ...JSON.parse(String(init.body)),
        id: appId,
        aud: `aud-${appId}`,
      };
      applications.set(appId, application);
      return envelope(application);
    }
    if (id && !init?.method) {
      const application = applications.get(id);
      return application ? envelope(application) : envelope(null, 404);
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
  });
  return {
    applications,
    fetcher,
    client: new ZeroTrustCloudflareClient('account-1', 'secret', fetcher),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ZeroTrustCloudflareClient', () => {
  const healthHostname = 'void-platform-health.apps.example.com';
  const healthDestination = `${healthHostname}/health`;
  function existingHealthApplication() {
    return {
      id: 'installer-health',
      name: 'void-installation-health-dispatch-nonce',
      type: 'self_hosted',
      aud: 'health-audience',
      domain: healthDestination,
      destinations: [{ type: 'public', uri: healthDestination }],
      // Installer defaults need not match project Access session/IdP settings.
      session_duration: '24h',
      policies: bypassPolicy('Void platform health check'),
    };
  }

  it('reuses and rechecks an installer health exception without taking ownership or writing', async () => {
    const { applications, client, fetcher } = applicationFixture();
    const existing = existingHealthApplication();
    applications.set(existing.id, existing);
    const expected = {
      id: existing.id,
      name: existing.name,
      audience: existing.aud,
      destinations: [healthDestination],
    };

    await expect(
      client.ensureHealthApplication('project-health', healthHostname, null),
    ).resolves.toEqual(expected);
    await expect(
      client.ensureHealthApplication('project-health', healthHostname, expected),
    ).resolves.toEqual(expected);
    await expect(
      client.inspectHealthApplication(expected, 'project-health', healthHostname),
    ).resolves.toEqual({ present: true, drifted: false });
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    expect(applications.get(existing.id)).toEqual(existing);
  });

  it.each([
    [
      'extra hostname',
      {
        destinations: [
          { type: 'public', uri: healthDestination },
          { type: 'public', uri: '*.apps.example.com' },
        ],
      },
    ],
    [
      'private destination',
      {
        destinations: [
          { type: 'public', uri: healthDestination },
          { type: 'private', hostname: 'internal.example.com' },
        ],
      },
    ],
    [
      'Worker target',
      { target_criteria: [{ target_attributes: [{ name: 'worker_name', value: ['dispatch'] }] }] },
    ],
    ['allow policy', { policies: [{ decision: 'allow', include: [{ everyone: {} }] }] }],
    ['extra policy', { policies: [...bypassPolicy('Health'), ...bypassPolicy('Other')] }],
    [
      'require rule',
      {
        policies: [
          { ...bypassPolicy('Health')[0], require: [{ email_domain: { domain: 'example.com' } }] },
        ],
      },
    ],
    ['exclude rule', { policies: [{ ...bypassPolicy('Health')[0], exclude: [{ everyone: {} }] }] }],
  ])(
    'rejects an external health exception with %s without changing it',
    async (_label, changes) => {
      const { applications, client, fetcher } = applicationFixture();
      const existing = { ...existingHealthApplication(), ...changes };
      applications.set(existing.id, existing);
      await expect(
        client.ensureHealthApplication('project-health', healthHostname, null),
      ).rejects.toThrow('existing Access');
      expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
      expect(applications.get(existing.id)).toEqual(existing);
    },
  );

  it('rejects ambiguous health exceptions and detects changes to a saved external reference', async () => {
    const { applications, client, fetcher } = applicationFixture();
    const existing = existingHealthApplication();
    applications.set(existing.id, existing);
    applications.set('duplicate', { ...existing, id: 'duplicate', name: 'other-health' });
    await expect(
      client.ensureHealthApplication('project-health', healthHostname, null),
    ).rejects.toThrow('Multiple Access applications');
    applications.delete('duplicate');
    const reference = await client.ensureHealthApplication('project-health', healthHostname, null);
    applications.set(existing.id, { ...existing, aud: 'changed-audience' });
    await expect(
      client.ensureHealthApplication('project-health', healthHostname, reference),
    ).rejects.toThrow('recorded identity');
    applications.delete(existing.id);
    await expect(
      client.ensureHealthApplication('project-health', healthHostname, reference),
    ).rejects.toThrow('missing');
    await expect(
      client.inspectHealthApplication(reference, 'project-health', healthHostname),
    ).resolves.toEqual({ present: false, drifted: true });
    expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('calls the global fetch without binding it to the client by default', async () => {
    const requests: Array<string> = [];
    // Workers rejects a host fetch invoked with any receiver other than the global object.
    vi.stubGlobal('fetch', function (this: unknown, input: string | URL | Request) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      }
      requests.push(input.toString());
      return Promise.resolve(envelope({ auth_domain: 'company.cloudflareaccess.com' }));
    });
    const client = new ZeroTrustCloudflareClient('account-1', 'secret');

    await expect(client.getOrganization()).resolves.toEqual({
      teamDomain: 'https://company.cloudflareaccess.com',
    });
    expect(requests).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/account-1/access/organizations',
    ]);
  });

  it('validates the organization, selected identity providers, and reusable policies', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith('/organizations')) {
        return envelope({ auth_domain: 'company.cloudflareaccess.com' });
      }
      if (path.endsWith('/identity_providers/idp-1')) {
        return envelope({ id: 'idp-1' });
      }
      if (path.endsWith('/policies/policy-1')) {
        return envelope({
          id: 'policy-1',
          decision: 'allow',
          include: [{ email_domain: { domain: 'example.com' } }],
        });
      }
      throw new Error(`unexpected request: ${input}`);
    });
    const client = new ZeroTrustCloudflareClient('account-1', 'secret', fetcher);

    await expect(
      client.validateSelection({ identityProviderIds: ['idp-1'], policyIds: ['policy-1'] }),
    ).resolves.toEqual({ teamDomain: 'https://company.cloudflareaccess.com' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects policies that can bypass company identity', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith('/organizations')) {
        return envelope({ auth_domain: 'company.cloudflareaccess.com' });
      }
      if (path.endsWith('/identity_providers/idp-1')) {
        return envelope({ id: 'idp-1' });
      }
      return envelope({ decision: 'allow', include: [{ everyone: {} }] });
    });
    const client = new ZeroTrustCloudflareClient('account-1', 'secret', fetcher);

    await expect(
      client.validateSelection({ identityProviderIds: ['idp-1'], policyIds: ['unsafe'] }),
    ).rejects.toThrow('must not allow Everyone');
  });

  it('rejects an allow policy with a non-identity alternative', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith('/organizations')) {
        return envelope({ auth_domain: 'company.cloudflareaccess.com' });
      }
      if (path.endsWith('/identity_providers/idp-1')) {
        return envelope({ id: 'idp-1' });
      }
      return envelope({
        decision: 'allow',
        include: [{ email_domain: { domain: 'example.com' } }, { country: { country_code: 'US' } }],
      });
    });
    const client = new ZeroTrustCloudflareClient('account-1', 'secret', fetcher);

    await expect(
      client.validateSelection({ identityProviderIds: ['idp-1'], policyIds: ['mixed'] }),
    ).rejects.toThrow('must restrict company identities');
  });

  it('creates, verifies, updates, and deletes a self-hosted application', async () => {
    const applications = new Map<string, Record<string, unknown>>();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const appMatch = url.pathname.match(/\/apps\/([^/]+)$/);
      if (url.pathname.endsWith('/apps') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const app = { ...body, id: 'app-1', aud: 'aud-1' };
        applications.set('app-1', app);
        return envelope(app);
      }
      if (url.pathname.endsWith('/apps')) {
        return envelope([...applications.values()]);
      }
      if (appMatch && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const app = { ...body, id: appMatch[1], aud: 'aud-1' };
        applications.set(appMatch[1], app);
        return envelope(app);
      }
      if (appMatch && init?.method === 'DELETE') {
        applications.delete(appMatch[1]);
        return envelope({ id: appMatch[1] });
      }
      if (appMatch) {
        const app = applications.get(appMatch[1]);
        return app ? envelope(app) : envelope(null, 404);
      }
      throw new Error(`unexpected request: ${input}`);
    });
    const client = new ZeroTrustCloudflareClient('account-1', 'secret', fetcher);
    const spec = {
      name: 'void-installation-project-zero-trust',
      destinations: ['*.apps.example.com'],
      allowedIdentityProviderIds: ['idp-1'],
      policies: reusablePolicyReferences(['policy-1']),
    };

    const created = await client.ensureApplication(spec);
    expect(created).toEqual({
      id: 'app-1',
      name: spec.name,
      audience: 'aud-1',
      destinations: spec.destinations,
    });
    const createCall = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      type: 'self_hosted',
      domain: '*.apps.example.com',
      allowed_idps: ['idp-1'],
      policies: [{ id: 'policy-1', precedence: 1 }],
    });

    await client.ensureApplication(spec, { id: created.id, name: created.name });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true);
    await expect(client.inspectApplication(created, spec)).resolves.toEqual({
      present: true,
      drifted: false,
    });
    applications.set('app-1', { ...applications.get('app-1'), allowed_idps: ['other-idp'] });
    await expect(client.inspectApplication(created, spec)).resolves.toEqual({
      present: true,
      drifted: true,
    });
    applications.set('app-1', {
      ...applications.get('app-1'),
      allowed_idps: ['idp-1'],
      destinations: [
        { type: 'public', uri: '*.apps.example.com' },
        { type: 'public', uri: 'unexpected.example.com' },
      ],
    });
    await expect(client.inspectApplication(created, spec)).resolves.toEqual({
      present: true,
      drifted: true,
    });
    await client.deleteApplication(created.id, created.name);
    expect(applications.size).toBe(0);
    expect(
      fetcher.mock.calls.filter(
        ([input, init]) => new URL(input.toString()).pathname.endsWith('/apps') && !init?.method,
      ),
    ).toHaveLength(1);
  });

  it('recovers and deletes an application from a durable name checkpoint', async () => {
    const application = {
      id: 'created-before-checkpoint',
      name: 'void-installation-public-project',
      aud: 'aud-recovered',
      domain: 'project.apps.example.com',
      destinations: [{ type: 'public', uri: 'project.apps.example.com' }],
    };
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith('/apps') && !init?.method) {
        return envelope([application]);
      }
      if (path.endsWith(`/apps/${application.id}`) && init?.method === 'PUT') {
        return envelope({
          ...JSON.parse(String(init.body)),
          id: application.id,
          aud: application.aud,
        });
      }
      if (path.endsWith(`/apps/${application.id}`) && init?.method === 'DELETE') {
        return envelope({ id: application.id });
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    const client = new ZeroTrustCloudflareClient('account-1', 'secret', fetcher);
    const recovered = await client.ensureApplication(
      {
        name: application.name,
        destinations: ['project.apps.example.com'],
        policies: bypassPolicy('Public project'),
      },
      { name: application.name },
    );
    expect(recovered.id).toBe(application.id);

    await client.deleteApplication(null, application.name);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  });

  it('rejects a mutation response that retains a stale protection policy', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith('/apps') && !init?.method) {
        return envelope([]);
      }
      if (path.endsWith('/apps') && init?.method === 'POST') {
        return envelope({
          ...JSON.parse(String(init.body)),
          id: 'app-stale-policy',
          aud: 'aud-stale-policy',
          policies: [{ id: 'old-policy', precedence: 1 }],
        });
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    const client = new ZeroTrustCloudflareClient('account-1', 'secret', fetcher);

    await expect(
      client.ensureApplication({
        name: 'void-protected-project',
        destinations: ['project.apps.example.com'],
        allowedIdentityProviderIds: ['idp-1'],
        policies: reusablePolicyReferences(['policy-1']),
      }),
    ).rejects.toThrow('did not retain the requested application configuration');
  });

  it('does not adopt or mutate an unrecorded same-name application', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith('/apps') && !init?.method) {
        return envelope([
          {
            id: 'unowned-app',
            name: 'void-installation-project-zero-trust',
            aud: 'unowned-audience',
            domain: '*.apps.example.com',
          },
        ]);
      }
      throw new Error(`unexpected mutation: ${init?.method ?? 'GET'} ${path}`);
    });
    const client = new ZeroTrustCloudflareClient('account-1', 'secret', fetcher);

    await expect(
      client.ensureApplication({
        name: 'void-installation-project-zero-trust',
        destinations: ['*.apps.example.com'],
        policies: reusablePolicyReferences(['policy-1']),
      }),
    ).rejects.toThrow('exists without a recorded Void creation intent');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  describe.each(['ensure', 'delete'] as const)(
    '%s with concurrent application changes',
    (operation) => {
      it('reads a recorded ID created after an earlier inventory instead of treating it as absent', async () => {
        const { applications, client, fetcher } = applicationFixture();
        await client.ensureApplication(applicationSpec('void-earlier-project'));
        const spec = applicationSpec('void-concurrent-project');
        applications.set('concurrent-app', { id: 'concurrent-app', name: spec.name });
        fetcher.mockClear();

        if (operation === 'ensure') {
          await expect(
            client.ensureApplication(spec, { id: 'concurrent-app', name: spec.name }),
          ).resolves.toMatchObject({ id: 'concurrent-app' });
          expect(applications.size).toBe(2);
        } else {
          await client.deleteApplication('concurrent-app', spec.name);
          expect(applications.has('concurrent-app')).toBe(false);
        }
        expect(
          fetcher.mock.calls.map(([input, init]) => [
            new URL(input.toString()).pathname,
            init?.method ?? 'GET',
          ]),
        ).toEqual([
          ['/client/v4/accounts/account-1/access/apps/concurrent-app', 'GET'],
          [
            '/client/v4/accounts/account-1/access/apps/concurrent-app',
            operation === 'ensure' ? 'PUT' : 'DELETE',
          ],
        ]);
      });

      it('recovers a durable name checkpoint from a fresh inventory', async () => {
        const { applications, client, fetcher } = applicationFixture();
        await client.ensureApplication(applicationSpec('void-earlier-project'));
        const spec = applicationSpec('void-concurrent-project');
        applications.set('checkpoint-app', { id: 'checkpoint-app', name: spec.name });
        fetcher.mockClear();

        if (operation === 'ensure') {
          await expect(client.ensureApplication(spec, { name: spec.name })).resolves.toMatchObject({
            id: 'checkpoint-app',
          });
          expect(applications.size).toBe(2);
        } else {
          await client.deleteApplication(null, spec.name);
          expect(applications.has('checkpoint-app')).toBe(false);
        }
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(new URL(fetcher.mock.calls[0][0].toString()).pathname).toMatch(/\/apps$/);
        expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      });

      it('does not recover an earlier name match after the application was renamed', async () => {
        const { applications, client, fetcher } = applicationFixture();
        const spec = applicationSpec('void-project');
        const created = await client.ensureApplication(spec);
        applications.set(created.id, {
          ...applications.get(created.id),
          name: 'unowned-application',
        });
        fetcher.mockClear();

        if (operation === 'ensure') {
          const recovered = await client.ensureApplication(spec, { name: spec.name });
          expect(recovered.id).not.toBe(created.id);
        } else {
          await client.deleteApplication(null, spec.name);
        }
        expect(applications.get(created.id)?.name).toBe('unowned-application');
        expect(
          fetcher.mock.calls.every(
            ([input]) => !new URL(input.toString()).pathname.endsWith(`/apps/${created.id}`),
          ),
        ).toBe(true);
      });

      it('rejects ambiguous name recovery after another application acquires the same name', async () => {
        const { applications, client, fetcher } = applicationFixture();
        const spec = applicationSpec('void-project');
        await client.ensureApplication(spec);
        applications.set('duplicate-app', { id: 'duplicate-app', name: spec.name });
        fetcher.mockClear();

        const result =
          operation === 'ensure'
            ? client.ensureApplication(spec, { name: spec.name })
            : client.deleteApplication(null, spec.name);
        await expect(result).rejects.toThrow('Multiple Cloudflare Access applications');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(applications.size).toBe(2);
      });

      it('preserves inventory errors during name checkpoint recovery', async () => {
        const { client, fetcher } = applicationFixture();
        const spec = applicationSpec('void-project');
        await client.ensureApplication(spec);
        fetcher.mockClear();
        fetcher.mockResolvedValueOnce(envelope(null, 429));

        const result =
          operation === 'ensure'
            ? client.ensureApplication(spec, { name: spec.name })
            : client.deleteApplication(null, spec.name);
        await expect(result).rejects.toThrow('HTTP 429');
        expect(fetcher).toHaveBeenCalledTimes(1);
      });

      it('refuses a recorded ID that was renamed after an earlier inventory', async () => {
        const { applications, client, fetcher } = applicationFixture();
        const spec = applicationSpec('void-project');
        const created = await client.ensureApplication(spec);
        applications.set(created.id, {
          ...applications.get(created.id),
          name: 'unowned-application',
        });
        fetcher.mockClear();

        const result =
          operation === 'ensure'
            ? client.ensureApplication(spec, created)
            : client.deleteApplication(created.id, spec.name);
        await expect(result).rejects.toThrow('no longer has its Void-owned name');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
      });

      it("recovers the replacement holding a missing recorded ID's name", async () => {
        const { applications, client, fetcher } = applicationFixture();
        const spec = applicationSpec('void-project');
        const created = await client.ensureApplication(spec);
        const recorded = applications.get(created.id)!;
        applications.delete(created.id);
        // Void recreated the application, but the create response was lost.
        applications.set('replacement-app', {
          ...recorded,
          id: 'replacement-app',
          aud: 'aud-replacement-app',
        });
        fetcher.mockClear();

        if (operation === 'ensure') {
          await expect(client.ensureApplication(spec, created)).resolves.toMatchObject({
            id: 'replacement-app',
            audience: 'aud-replacement-app',
          });
          expect(fetcher.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
            'GET',
            'GET',
            'PUT',
          ]);
          expect([...applications.keys()]).toEqual(['replacement-app']);
        } else {
          await expect(client.deleteApplication(created.id, spec.name)).resolves.toBeUndefined();
          expect(applications.size).toBe(0);
        }
      });

      it('rejects a missing recorded ID when several applications hold its name', async () => {
        const { applications, client, fetcher } = applicationFixture();
        const spec = applicationSpec('void-project');
        const created = await client.ensureApplication(spec);
        applications.delete(created.id);
        applications.set('replacement-app', { id: 'replacement-app', name: spec.name });
        applications.set('duplicate-app', { id: 'duplicate-app', name: spec.name });
        fetcher.mockClear();

        const result =
          operation === 'ensure'
            ? client.ensureApplication(spec, created)
            : client.deleteApplication(created.id, spec.name);
        await expect(result).rejects.toThrow('Multiple Cloudflare Access applications');
        expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
        expect(applications.size).toBe(2);
      });

      it('treats an authoritative 404 as an absent recorded application', async () => {
        const { applications, client } = applicationFixture();
        const spec = applicationSpec('void-project');
        const created = await client.ensureApplication(spec);
        applications.delete(created.id);

        if (operation === 'ensure') {
          const recreated = await client.ensureApplication(spec, created);
          expect(recreated.id).not.toBe(created.id);
          expect(applications.size).toBe(1);
        } else {
          await expect(client.deleteApplication(created.id, spec.name)).resolves.toBeUndefined();
          expect(applications.size).toBe(0);
        }
      });

      it.each([403, 429, 500])(
        'preserves provider failure HTTP %s instead of treating the ID as absent',
        async (status) => {
          const fetcher = vi.fn<typeof fetch>(async () => envelope(null, status));
          const client = new ZeroTrustCloudflareClient('account-1', 'secret', fetcher);
          const spec = applicationSpec('void-project');
          const result =
            operation === 'ensure'
              ? client.ensureApplication(spec, { id: 'recorded-app', name: spec.name })
              : client.deleteApplication('recorded-app', spec.name);

          await expect(result).rejects.toThrow(`HTTP ${status}`);
          expect(fetcher).toHaveBeenCalledTimes(1);
          expect(new URL(fetcher.mock.calls[0][0].toString()).pathname).toMatch(
            /\/apps\/recorded-app$/,
          );
        },
      );

      it('rejects a read response for a different application ID', async () => {
        const spec = applicationSpec('void-project');
        const fetcher = vi.fn(async () => envelope({ id: 'different-app', name: spec.name }));
        const client = new ZeroTrustCloudflareClient('account-1', 'secret', fetcher);
        const result =
          operation === 'ensure'
            ? client.ensureApplication(spec, { id: 'recorded-app', name: spec.name })
            : client.deleteApplication('recorded-app', spec.name);

        await expect(result).rejects.toThrow('different Access application id');
        expect(fetcher).toHaveBeenCalledTimes(1);
      });
    },
  );

  it('rejects an unowned same-name application added after an earlier inventory', async () => {
    const { applications, client, fetcher } = applicationFixture();
    await client.ensureApplication(applicationSpec('void-earlier-project'));
    const spec = applicationSpec('void-project');
    applications.set('unowned-app', { id: 'unowned-app', name: spec.name });
    fetcher.mockClear();

    await expect(client.ensureApplication(spec)).rejects.toThrow(
      'without a recorded Void creation intent',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(applications.size).toBe(2);
  });
});
