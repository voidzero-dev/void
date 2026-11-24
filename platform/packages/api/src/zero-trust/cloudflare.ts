import { isPlatformAccessIdentityRule } from '@void/platform';
import type { ManagedAccessApplication } from './configuration.ts';

type ObjectValue = Record<string, unknown>;

type CloudflareEnvelope<T> = Readonly<{
  success?: boolean;
  result?: T;
  errors?: ReadonlyArray<{ code?: number; message?: string }>;
}>;

export class ZeroTrustCloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ZeroTrustCloudflareError';
  }
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cloudflare returned an invalid ${label}.`);
  }
  return value as ObjectValue;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 8192) {
    throw new Error(`Cloudflare did not return ${label}.`);
  }
  return value;
}

/**
 * Saved selections are checked again on every reconcile and domain change, so
 * project Zero Trust keeps accepting every login method rule it accepted before.
 * A stricter check here would stop running installations.
 */
const anyLoginMethod = (): boolean => true;

function destinationList(application: ObjectValue): ReadonlyArray<string> {
  const destinations = Array.isArray(application.destinations) ? application.destinations : [];
  return [
    ...(typeof application.domain === 'string' ? [application.domain] : []),
    ...destinations.flatMap((value) => {
      const destination = object(value, 'Access application destination');
      return destination.type === 'public' && typeof destination.uri === 'string'
        ? [destination.uri]
        : [];
    }),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

type AccessApplicationSpec = Readonly<{
  name: string;
  destinations: ReadonlyArray<string>;
  allowedIdentityProviderIds?: ReadonlyArray<string>;
  policies: ReadonlyArray<ObjectValue>;
}>;

function sameDestinations(
  application: ObjectValue,
  expectedDestinations: ReadonlyArray<string>,
): boolean {
  const actual = [...destinationList(application)].sort();
  const expected = [...new Set(expectedDestinations)].sort();
  return (
    actual.length === expected.length &&
    expected.every((destination, index) => destination === actual[index])
  );
}

function samePolicies(actualValue: unknown, expected: ReadonlyArray<ObjectValue>): boolean {
  if (!Array.isArray(actualValue) || actualValue.length !== expected.length) {
    return false;
  }
  return expected.every((expectedPolicy, index) => {
    const actualPolicy = object(actualValue[index], 'Access application policy');
    if (actualPolicy.precedence !== expectedPolicy.precedence) {
      return false;
    }
    if (typeof expectedPolicy.id === 'string') {
      return actualPolicy.id === expectedPolicy.id;
    }
    return (
      actualPolicy.decision === expectedPolicy.decision &&
      JSON.stringify(actualPolicy.include) === JSON.stringify(expectedPolicy.include)
    );
  });
}

function applicationConfigurationDrift(
  application: ObjectValue,
  spec: AccessApplicationSpec,
): boolean {
  const expectedIdps = [...(spec.allowedIdentityProviderIds ?? [])].sort();
  const actualIdps = Array.isArray(application.allowed_idps)
    ? application.allowed_idps.filter((value): value is string => typeof value === 'string').sort()
    : [];
  const idpsDrifted = spec.allowedIdentityProviderIds
    ? actualIdps.length !== expectedIdps.length ||
      !expectedIdps.every((id, index) => id === actualIdps[index]) ||
      application.auto_redirect_to_identity !== (expectedIdps.length === 1)
    : actualIdps.length > 0 || application.auto_redirect_to_identity === true;
  return (
    application.name !== spec.name ||
    application.type !== 'self_hosted' ||
    application.session_duration !== '12h' ||
    !sameDestinations(application, spec.destinations) ||
    idpsDrifted ||
    !samePolicies(application.policies, spec.policies)
  );
}

export class ZeroTrustCloudflareClient {
  readonly #base: string;

  constructor(
    accountId: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = (input, options) => fetch(input, options),
    apiBase = 'https://api.cloudflare.com/client/v4',
  ) {
    this.#base = `${apiBase.replace(/\/+$/, '')}/accounts/${encodeURIComponent(accountId)}/access`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await this.fetcher(`${this.#base}/${path.replace(/^\/+/, '')}`, {
      ...init,
      headers,
      redirect: 'manual',
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
    let body: CloudflareEnvelope<T>;
    try {
      body = await response.json<CloudflareEnvelope<T>>();
    } catch {
      throw new ZeroTrustCloudflareError(
        `Cloudflare returned a non-JSON response (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (!response.ok || body.success !== true || body.result === undefined) {
      const detail =
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join(', ') || `HTTP ${response.status}`;
      throw new ZeroTrustCloudflareError(
        `Cloudflare Zero Trust API error: ${detail} (HTTP ${response.status}).`,
        response.status,
      );
    }
    return body.result;
  }

  async getOrganization(): Promise<{ teamDomain: string }> {
    const organization = object(await this.request('organizations'), 'Access organization');
    const authDomain = text(organization.auth_domain, 'Access team domain');
    const teamDomain = (
      authDomain.startsWith('https://') ? authDomain : `https://${authDomain}`
    ).replace(/\/+$/, '');
    const url = new URL(teamDomain);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.cloudflareaccess.com') ||
      url.origin !== teamDomain
    ) {
      throw new Error('Cloudflare returned an invalid Access team domain.');
    }
    return { teamDomain };
  }

  async validateSelection(input: {
    identityProviderIds: ReadonlyArray<string>;
    policyIds: ReadonlyArray<string>;
  }): Promise<{ teamDomain: string }> {
    const [{ teamDomain }, ...providers] = await Promise.all([
      this.getOrganization(),
      ...input.identityProviderIds.map((id) =>
        this.request(`identity_providers/${encodeURIComponent(id)}`),
      ),
    ]);
    for (const [index, provider] of providers.entries()) {
      if (
        text(object(provider, 'identity provider').id, 'identity provider id') !==
        input.identityProviderIds[index]
      ) {
        throw new Error(
          `Cloudflare Access identity provider ${input.identityProviderIds[index]} is unavailable.`,
        );
      }
    }
    const policies = await Promise.all(
      input.policyIds.map((id) =>
        this.request(`policies/${encodeURIComponent(id)}`).then((value) =>
          object(value, 'Access policy'),
        ),
      ),
    );
    await this.verifyCompanyPolicies(policies);
    return { teamDomain };
  }

  private async verifyCompanyPolicies(policies: ReadonlyArray<ObjectValue>): Promise<void> {
    let allowPolicies = 0;
    const inspectedGroups = new Set<string>();
    const activeGroups = new Set<string>();
    const checkRules = async (value: unknown, depth = 0): Promise<void> => {
      if (value === undefined) {
        return;
      }
      if (!Array.isArray(value) || value.length > 100 || depth > 8) {
        throw new Error('Access policies must contain bounded identity rules.');
      }
      for (const raw of value) {
        const rule = object(raw, 'Access policy rule');
        if (Object.hasOwn(rule, 'everyone') || Object.hasOwn(rule, 'any_valid_service_token')) {
          throw new Error('Access project policies must not allow Everyone or any service token.');
        }
        if (rule.group) {
          const id = text(object(rule.group, 'Access group rule').id, 'Access group id');
          if (activeGroups.has(id)) {
            throw new Error('Access groups contain a recursive membership rule.');
          }
          if (!inspectedGroups.has(id)) {
            if (inspectedGroups.size >= 100) {
              throw new Error('Access group policy exceeds the inspection limit.');
            }
            activeGroups.add(id);
            const group = object(
              await this.request(`groups/${encodeURIComponent(id)}`),
              'Access group',
            );
            await checkRules(group.include, depth + 1);
            await checkRules(group.require, depth + 1);
            if (!Array.isArray(group.include) || group.include.length < 1) {
              throw new Error('Access groups must contain explicit identity rules.');
            }
            const groupHasRequiredIdentity =
              Array.isArray(group.require) &&
              group.require.some((entry) =>
                isPlatformAccessIdentityRule(object(entry, 'Access group rule'), anyLoginMethod),
              );
            if (
              !groupHasRequiredIdentity &&
              !group.include.every((entry) =>
                isPlatformAccessIdentityRule(object(entry, 'Access group rule'), anyLoginMethod),
              )
            ) {
              throw new Error('Access groups must restrict company identities.');
            }
            activeGroups.delete(id);
            inspectedGroups.add(id);
          }
        }
      }
    };
    for (const policy of policies) {
      if (policy.decision === 'bypass' || policy.decision === 'non_identity') {
        throw new Error('Bypass and non-identity policies cannot protect Void projects.');
      }
      if (policy.decision !== 'allow' && policy.decision !== 'deny') {
        throw new Error('Unsupported Cloudflare Access policy decision.');
      }
      if (policy.decision === 'allow') {
        allowPolicies += 1;
        await checkRules(policy.include);
        await checkRules(policy.require);
        const hasRequiredIdentity =
          Array.isArray(policy.require) &&
          policy.require.some((entry) =>
            isPlatformAccessIdentityRule(object(entry, 'Access policy rule'), anyLoginMethod),
          );
        if (
          !Array.isArray(policy.include) ||
          policy.include.length < 1 ||
          (!hasRequiredIdentity &&
            !policy.include.every((entry) =>
              isPlatformAccessIdentityRule(object(entry, 'Access policy rule'), anyLoginMethod),
            ))
        ) {
          throw new Error('Access allow policies must restrict company identities.');
        }
      }
    }
    if (allowPolicies === 0) {
      throw new Error('Select at least one Cloudflare Access allow policy.');
    }
  }

  private applicationBody(spec: AccessApplicationSpec): ObjectValue {
    const destinations = [...new Set(spec.destinations)];
    if (destinations.length < 1 || destinations.length > 100) {
      throw new Error('An Access application needs between 1 and 100 destinations.');
    }
    return {
      name: spec.name,
      type: 'self_hosted',
      domain: destinations[0],
      destinations: destinations.map((uri) => ({ type: 'public', uri })),
      session_duration: '12h',
      ...(spec.allowedIdentityProviderIds
        ? {
            allowed_idps: [...spec.allowedIdentityProviderIds],
            auto_redirect_to_identity: spec.allowedIdentityProviderIds.length === 1,
          }
        : {}),
      policies: [...spec.policies],
    };
  }

  private async applications(): Promise<Map<string, ObjectValue>> {
    // Name checkpoints can come from another request after any earlier inventory.
    // Always refresh before using a name to recover ownership or establish absence.
    const entries: Array<ObjectValue> = [];
    for (let page = 1; page <= 6; page++) {
      const result = await this.request<ReadonlyArray<unknown>>(`apps?page=${page}&per_page=100`);
      const parsed = result.map((entry) => object(entry, 'Access application'));
      if (page === 6 && parsed.length > 0) {
        throw new Error(
          'Cloudflare Access has more than 500 applications; Void cannot safely reconcile this installation within provider limits.',
        );
      }
      entries.push(...parsed);
      if (parsed.length < 100) {
        break;
      }
    }
    return new Map(
      entries.map((application) => [text(application.id, 'application id'), application]),
    );
  }

  private async application(id: string): Promise<ObjectValue | null> {
    try {
      const application = object(
        await this.request(`apps/${encodeURIComponent(id)}`),
        'Access application',
      );
      if (text(application.id, 'application id') !== id) {
        throw new Error('Cloudflare returned a different Access application id.');
      }
      return application;
    } catch (error) {
      if (error instanceof ZeroTrustCloudflareError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private verifyApplication(
    application: ObjectValue,
    spec: AccessApplicationSpec,
  ): ManagedAccessApplication {
    const id = text(application.id, 'application id');
    const expectedDestinations = [...new Set(spec.destinations)].sort();
    if (applicationConfigurationDrift(application, spec)) {
      throw new Error('Cloudflare Access did not retain the requested application configuration.');
    }
    return {
      id,
      name: spec.name,
      audience: text(application.aud, 'application audience'),
      destinations: expectedDestinations,
    };
  }

  /**
   * Find the application Void recorded: by id first, then by its Void-owned
   * name. The name carries a random nonce committed before any create, so when
   * the recorded id is gone, the single application holding that name is
   * Void's own replacement whose create response was lost. `inventory` is
   * set when the name lookup ran.
   */
  private async locateOwnedApplication(
    id: string | null | undefined,
    name: string | null | undefined,
  ): Promise<{ application: ObjectValue | null; inventory?: Map<string, ObjectValue> }> {
    const application = id ? await this.application(id) : null;
    if (application) {
      if (name && application.name !== name) {
        throw new Error('The recorded Access application no longer has its Void-owned name.');
      }
      return { application };
    }
    if (!name) {
      return { application: null };
    }
    const inventory = await this.applications();
    const sameName = [...inventory.values()].filter((entry) => entry.name === name);
    if (sameName.length > 1) {
      throw new Error(`Multiple Cloudflare Access applications are named ${name}.`);
    }
    return { application: sameName[0] ?? null, inventory };
  }

  async ensureApplication(
    spec: AccessApplicationSpec,
    current?: Readonly<{ id?: string | null; name?: string | null }>,
  ): Promise<ManagedAccessApplication> {
    if (current?.name && current.name !== spec.name) {
      throw new Error('The recorded Access application no longer has its Void-owned name.');
    }
    let application: ObjectValue | null = null;
    let inventory: Map<string, ObjectValue> | undefined;
    if (current?.id || current?.name) {
      ({ application, inventory } = await this.locateOwnedApplication(current.id, spec.name));
    } else {
      // No recorded creation intent: the name must still be free.
      inventory = await this.applications();
      if ([...inventory.values()].some((entry) => entry.name === spec.name)) {
        throw new Error(
          `A Cloudflare Access application named ${spec.name} exists without a recorded Void creation intent.`,
        );
      }
    }
    const body = this.applicationBody(spec);
    if (application) {
      const id = text(application.id, 'application id');
      application = object(
        await this.request(`apps/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
        'updated Access application',
      );
      if (text(application.id, 'application id') !== id) {
        throw new Error('Cloudflare returned a different Access application id.');
      }
    } else {
      application = object(
        await this.request('apps', { method: 'POST', body: JSON.stringify(body) }),
        'created Access application',
      );
      const id = text(application.id, 'application id');
      if (inventory?.has(id)) {
        throw new Error('Cloudflare reused an existing Access application id.');
      }
    }
    return this.verifyApplication(application, spec);
  }

  async inspectApplication(
    application: ManagedAccessApplication,
    spec: AccessApplicationSpec,
  ): Promise<{
    present: boolean;
    drifted: boolean;
  }> {
    try {
      const current = object(
        await this.request(`apps/${encodeURIComponent(application.id)}`),
        'Access application',
      );
      return {
        present: true,
        drifted:
          current.name !== application.name ||
          current.aud !== application.audience ||
          applicationConfigurationDrift(current, spec),
      };
    } catch (error) {
      if (error instanceof ZeroTrustCloudflareError && error.status === 404) {
        return { present: false, drifted: true };
      }
      throw error;
    }
  }

  /** An installer/operator-owned health exception is verified, never modified or adopted. */
  private async verifyExistingHealthApplication(
    application: ObjectValue,
    hostname: string,
    current?: ManagedAccessApplication,
  ): Promise<ManagedAccessApplication> {
    const id = text(application.id, 'application id');
    const name = text(application.name, 'application name');
    const audience = text(application.aud, 'application audience');
    const destination = `${hostname}/health`;
    if (
      (current && (id !== current.id || name !== current.name || audience !== current.audience)) ||
      application.type !== 'self_hosted' ||
      application.domain !== destination ||
      !sameDestinations(application, [destination]) ||
      (application.destinations !== undefined &&
        (!Array.isArray(application.destinations) ||
          application.destinations.some((entry) => {
            const value = object(entry, 'Access application destination');
            return value.type !== 'public' || value.uri !== destination;
          }))) ||
      (application.target_criteria !== null &&
        application.target_criteria !== undefined &&
        (!Array.isArray(application.target_criteria) || application.target_criteria.length > 0))
    ) {
      throw new Error(
        `The existing Access health application must cover only ${destination} and retain its recorded identity.`,
      );
    }
    // Read policies directly: application inventory may contain only policy references.
    // Two entries are enough to reject anything other than a single exact bypass.
    const policies = await this.request<ReadonlyArray<ObjectValue>>(
      `apps/${encodeURIComponent(id)}/policies?page=1&per_page=2`,
    );
    const policy = policies?.[0];
    if (
      !Array.isArray(policies) ||
      policies.length !== 1 ||
      policy?.decision !== 'bypass' ||
      JSON.stringify(policy.include) !== '[{"everyone":{}}]' ||
      (policy.require !== undefined &&
        (!Array.isArray(policy.require) || policy.require.length > 0)) ||
      (policy.exclude !== undefined &&
        (!Array.isArray(policy.exclude) || policy.exclude.length > 0))
    ) {
      throw new Error(
        `The existing Access policy for ${destination} must remain the reserved health-check exception.`,
      );
    }
    return { id, name, audience, destinations: [destination] };
  }

  async ensureHealthApplication(
    name: string,
    hostname: string,
    current: ManagedAccessApplication | null,
  ): Promise<ManagedAccessApplication> {
    if (current && current.name !== name) {
      const application = await this.application(current.id);
      if (!application) {
        throw new Error(
          'The existing Access health application is missing. Restore it before reconciling project Zero Trust.',
        );
      }
      return this.verifyExistingHealthApplication(application, hostname, current);
    }
    const { application, inventory } = await this.locateOwnedApplication(current?.id, name);
    if (application) {
      return this.ensureApplication(healthCheckApplication(name, hostname), {
        id: text(application.id, 'application id'),
        name,
      });
    }
    const matches = [...inventory!.values()].filter((entry) =>
      destinationList(entry).includes(`${hostname}/health`),
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Access applications cover ${hostname}/health. Reconcile them before retrying.`,
      );
    }
    if (matches[0]) {
      const existing = await this.application(text(matches[0].id, 'application id'));
      if (!existing) {
        throw new Error(
          'The existing Access health application disappeared. Inspect Access before retrying.',
        );
      }
      return this.verifyExistingHealthApplication(existing, hostname);
    }
    return this.ensureApplication(healthCheckApplication(name, hostname), { name });
  }

  async inspectHealthApplication(
    current: ManagedAccessApplication,
    managedName: string | null,
    hostname: string,
  ): Promise<{ present: boolean; drifted: boolean }> {
    if (current.name === managedName) {
      return this.inspectApplication(current, healthCheckApplication(current.name, hostname));
    }
    const application = await this.application(current.id);
    if (!application) {
      return { present: false, drifted: true };
    }
    await this.verifyExistingHealthApplication(application, hostname, current);
    return { present: true, drifted: false };
  }

  async deleteApplication(
    id: string | null | undefined,
    expectedName?: string | null,
  ): Promise<void> {
    if (!id && !expectedName) {
      return;
    }
    const { application } = await this.locateOwnedApplication(id, expectedName);
    if (!application) {
      return;
    }
    const resolvedId = text(application.id, 'application id');
    try {
      await this.request(`apps/${encodeURIComponent(resolvedId)}`, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof ZeroTrustCloudflareError && error.status === 404)) {
        throw error;
      }
    }
  }
}

export function reusablePolicyReferences(policyIds: ReadonlyArray<string>) {
  return policyIds.map((id, index) => ({ id, precedence: index + 1 }));
}

export function bypassPolicy(name: string): ReadonlyArray<ObjectValue> {
  return [
    {
      name,
      decision: 'bypass',
      precedence: 1,
      include: [{ everyone: {} }],
    },
  ];
}

/**
 * The bypass that keeps platform health probes outside project Access. It
 * covers only `/health` (and, as Access matches paths, its subpaths) on the
 * health hostname; every other path there stays under the wildcard application.
 */
export function healthCheckApplication(name: string, hostname: string): AccessApplicationSpec {
  return {
    name,
    destinations: [`${hostname}/health`],
    policies: bypassPolicy('Void platform health check'),
  };
}

/** Prove app-management write authority without making an app namespace public. */
export function publicAppManagementDestination(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Public app management requires an HTTPS dispatch origin.');
  }
  return url.host + '/__void/app-access-management';
}

export function publicAppManagementApplication(
  name: string,
  destination: string,
): AccessApplicationSpec {
  return {
    name,
    destinations: [destination],
    policies: [
      {
        name: 'App access management check',
        decision: 'deny',
        precedence: 1,
        include: [{ everyone: {} }],
      },
    ],
  };
}
