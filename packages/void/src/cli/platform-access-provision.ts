import { createHash } from 'node:crypto';
import {
  isPlatformAccessCompanyIdentityProvider,
  isPlatformAccessIdentityRule,
  parsePlatformAccessProtection,
  parsePlatformLoginConfiguration,
} from '@void/platform';
import type { PlatformAccessProtection, PlatformLoginConfiguration } from '@void/platform';
import { PlatformCloudflareApiError } from './platform-cloudflare.ts';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';

type ObjectValue = Record<string, unknown>;
type AccessResource = {
  name: string;
  fingerprint: string;
  id?: string;
  clientId?: string;
  clientSecret?: string;
  pending: boolean;
  adopted?: boolean;
};
export type PlatformAccessCheckpoint = {
  version: 1;
  accountId: string;
  installationId: string;
  nonce: string;
  resources: Record<string, AccessResource>;
};
export type PlatformAccessProvisionInput = {
  accountId: string;
  installationId: string;
  apiUrl: string;
  proxyUrl: string;
  additionalOrigins?: ReadonlyArray<string>;
  identityProviderIds: ReadonlyArray<string>;
  policyIds: ReadonlyArray<string>;
  login?: {
    id: string;
    label: string;
    applicationId?: string;
    clientSecret?: string;
    requiredGroups?: ReadonlyArray<string>;
  };
  protection?: { applicationId?: string };
  serviceToken?: { id: string; clientId: string; clientSecret: string };
};
export type PlatformAccessProvisionResult = {
  login?: { configuration: PlatformLoginConfiguration; clientSecret: string };
  protection?: PlatformAccessProtection;
  credentials?: Record<string, { CF_ACCESS_CLIENT_ID: string; CF_ACCESS_CLIENT_SECRET: string }>;
  resources: ReadonlyArray<{ key: string; id: string; name: string; adopted: boolean }>;
};

function object(value: unknown, name: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`platform: Invalid ${name} response from Cloudflare Access.`);
  }
  return value as ObjectValue;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 8192) {
    throw new Error(`platform: Cloudflare Access did not return ${name}.`);
  }
  return value;
}
export function platformAccessIdentityProvider(provider: ObjectValue): {
  id: string;
  name: string;
} {
  const id = text(provider.id, 'identity provider ID');
  // Cloudflare's built-in provider can have an empty display name. Identity
  // selection still uses its validated ID, including in the interactive picker.
  const name = provider.name;
  return {
    id,
    name:
      name == null || (typeof name === 'string' && !name.trim())
        ? id
        : text(name, 'identity provider name'),
  };
}
function ids(value: unknown): Array<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) =>
    typeof entry === 'string' ? entry : text(object(entry, 'policy').id, 'policy ID'),
  );
}
function sameSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((id, index) => id === [...right].sort()[index])
  );
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function platformAccessNonce(ownershipNonce: string): string {
  return createHash('sha256').update(`void-access:${ownershipNonce}`).digest('hex').slice(0, 32);
}

export class PlatformAccessClient {
  constructor(
    private readonly client: Pick<PlatformCloudflareClient, 'request'>,
    readonly accountId: string,
  ) {}
  path(suffix: string): string {
    return `/accounts/${encodeURIComponent(this.accountId)}/access/${suffix}`;
  }
  get(suffix: string): Promise<unknown> {
    return this.client.request(this.path(suffix));
  }
  create(suffix: string, body: ObjectValue): Promise<unknown> {
    return this.client.request(this.path(suffix), { method: 'POST', body: JSON.stringify(body) });
  }
  async list(suffix: string): Promise<Array<ObjectValue>> {
    const result: Array<ObjectValue> = [];
    for (let page = 1; page <= 100; page++) {
      const value = await this.get(`${suffix}?page=${page}&per_page=100`);
      if (!Array.isArray(value)) {
        throw new Error('platform: Invalid Access inventory response.');
      }
      result.push(...value.map((entry) => object(entry, 'inventory')));
      if (value.length < 100) {
        return result;
      }
    }
    throw new Error('platform: Access inventory exceeded the supported pagination limit.');
  }
}

/** The selected providers or policies cannot protect Void; other errors are not about the selection. */
export class PlatformAccessPolicyRejectedError extends Error {}

/** Preserve corporate MFA/device requirements; reject broad policies rather than rewriting them. */
export async function verifyCompanyAccessPolicies(
  client: PlatformAccessClient,
  policies: ReadonlyArray<ObjectValue>,
  identityProviderIds: ReadonlyArray<string>,
  identityProviders?: ReadonlyArray<ObjectValue>,
): Promise<void> {
  const companyProviders = new Set(
    (identityProviders ?? (await client.list('identity_providers')))
      .filter(isPlatformAccessCompanyIdentityProvider)
      .map((provider) => provider.id),
  );
  // The applications offer only the selected providers at sign-in, so a login
  // method, Entra ID group or authentication context rule for any other
  // provider matches nobody.
  const selectedCompanyProviders = new Set(
    identityProviderIds.filter((id) => companyProviders.has(id)),
  );
  const identityRule = (
    entry: unknown,
    name: string,
    providers: ReadonlySet<unknown> = selectedCompanyProviders,
  ) => {
    const rule = object(entry, name);
    const entra = rule.azureAD || rule.auth_context;
    if (entra) {
      const id = typeof entra === 'object' ? (entra as ObjectValue).identity_provider_id : null;
      return typeof id === 'string' && providers.has(id);
    }
    return isPlatformAccessIdentityRule(rule, (id) => providers.has(id));
  };
  const restricted = (target: ObjectValue, providers?: ReadonlySet<unknown>) =>
    Array.isArray(target.include) &&
    target.include.length > 0 &&
    ((Array.isArray(target.require) &&
      target.require.some((entry) => identityRule(entry, 'policy rule', providers))) ||
      target.include.every((entry) => identityRule(entry, 'policy rule', providers)));
  const groups = new Set<string>();
  const checkedGroups = new Set<string>();
  const checkRules = async (value: unknown, depth = 0): Promise<void> => {
    if (value === undefined) {
      return;
    }
    if (!Array.isArray(value) || value.length > 100 || depth > 8) {
      throw new PlatformAccessPolicyRejectedError(
        'platform: Unsupported Access policy rule structure.',
      );
    }
    for (const entry of value) {
      const rule = object(entry, 'policy rule');
      if (Object.hasOwn(rule, 'everyone') || Object.hasOwn(rule, 'any_valid_service_token')) {
        throw new PlatformAccessPolicyRejectedError(
          'platform: Company Access policies must not allow Everyone or any valid service token.',
        );
      }
      if (rule.group) {
        const id = text(object(rule.group, 'Access group').id, 'Access group ID');
        if (groups.has(id)) {
          throw new PlatformAccessPolicyRejectedError(
            'platform: Access groups contain a recursive membership rule.',
          );
        }
        if (checkedGroups.has(id)) {
          continue;
        }
        if (checkedGroups.size >= 100) {
          throw new PlatformAccessPolicyRejectedError(
            'platform: Access group policy exceeds the inspection limit.',
          );
        }
        groups.add(id);
        const group = object(await client.get(`groups/${encodeURIComponent(id)}`), 'Access group');
        await checkRules(group.include, depth + 1);
        await checkRules(group.require, depth + 1);
        if (!Array.isArray(group.include) || !group.include.length) {
          throw new PlatformAccessPolicyRejectedError(
            'platform: Access groups must contain explicit identity rules.',
          );
        }
        if (
          !(
            Array.isArray(group.require) &&
            group.require.some((entry) => identityRule(entry, 'group rule'))
          ) &&
          !group.include.every((entry) => identityRule(entry, 'group rule'))
        ) {
          throw new PlatformAccessPolicyRejectedError(
            'platform: Access groups must restrict company identities.',
          );
        }
        groups.delete(id);
        checkedGroups.add(id);
      }
    }
  };
  let allows = 0;
  for (const policy of policies) {
    if (!['allow', 'deny', 'non_identity', 'bypass'].includes(String(policy.decision))) {
      throw new PlatformAccessPolicyRejectedError('platform: Unsupported Access policy decision.');
    }
    if (policy.decision === 'bypass') {
      throw new PlatformAccessPolicyRejectedError(
        'platform: A bypass policy cannot protect a Void platform.',
      );
    }
    if (policy.decision !== 'allow') {
      continue;
    }
    allows++;
    await checkRules(policy.include);
    await checkRules(policy.require);
    if (!restricted(policy)) {
      throw new PlatformAccessPolicyRejectedError(
        restricted(policy, companyProviders)
          ? 'platform: An Access allow policy uses an identity provider that is not one of the selected identity providers.'
          : 'platform: Select Access allow policies restricted to company identities.',
      );
    }
  }
  if (!allows) {
    throw new PlatformAccessPolicyRejectedError(
      'platform: Select at least one company Access allow policy.',
    );
  }
}

export function platformAccessPublicDestinations(application: ObjectValue): Array<string> {
  const destinations = Array.isArray(application.destinations) ? application.destinations : [];
  return [
    ...(typeof application.domain === 'string' ? [application.domain] : []),
    ...destinations.flatMap((value) => {
      const entry = object(value, 'Access destination');
      return entry.type === 'public' && typeof entry.uri === 'string' ? [entry.uri] : [];
    }),
  ];
}
function platformAccessOverlapsOrigin(destination: string, origin: string): boolean {
  const host = destination.split('/')[0]!;
  const pattern =
    '^' +
    host
      .split('*')
      .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
      .join('.*') +
    '$';
  return new RegExp(pattern, 'i').test(new URL(origin).hostname);
}
/** Whether an application path-covers, or exactly covers, any protected platform origin. */
export function platformAccessOverlapsOrigins(
  application: ObjectValue,
  origins: ReadonlyArray<string>,
): boolean {
  return platformAccessPublicDestinations(application).some(
    (destination) =>
      origins.some((origin) => platformAccessOverlapsOrigin(destination, origin)) &&
      (destination.includes('/') ||
        origins.some((origin) => destination === new URL(origin).hostname)),
  );
}
/** A definitive 4xx means the create did not happen, so a retry may not find a hidden duplicate. */
export function platformAccessCreateRejected(error: unknown): boolean {
  return (
    error instanceof PlatformCloudflareApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 429].includes(error.status)
  );
}

/** Read reusable policies by ID and check that together they admit only company identities. */
export async function verifySelectedAccessPolicies(
  client: PlatformAccessClient,
  policyIds: ReadonlyArray<string>,
  identityProviderIds: ReadonlyArray<string>,
  identityProviders?: ReadonlyArray<ObjectValue>,
): Promise<Array<ObjectValue>> {
  const policies = await Promise.all(
    policyIds.map(async (id) => {
      try {
        return object(await client.get(`policies/${encodeURIComponent(id)}`), 'Access policy');
      } catch (error) {
        if (error instanceof PlatformCloudflareApiError && error.status === 404) {
          throw new PlatformAccessPolicyRejectedError(
            `platform: The selected Access policy ${encodeURIComponent(id)} is unavailable in this account.`,
            { cause: error },
          );
        }
        throw error;
      }
    }),
  );
  await verifyCompanyAccessPolicies(client, policies, identityProviderIds, identityProviders);
  return policies;
}

export async function inspectPlatformAccess(
  client: PlatformAccessClient,
  input: Pick<PlatformAccessProvisionInput, 'identityProviderIds' | 'policyIds'>,
): Promise<{
  teamDomain: string;
  identityProviders: Array<{ id: string; name: string }>;
  policies: Array<ObjectValue>;
}> {
  const organization = object(await client.get('organizations'), 'Access organization');
  const authDomain = text(organization.auth_domain, 'Access team domain');
  const teamDomain = authDomain.startsWith('https://') ? authDomain : `https://${authDomain}`;
  // Reuse the runtime validator to avoid accepting a credential destination outside Access.
  parsePlatformAccessProtection({
    teamDomain,
    applications: [{ origin: 'https://validation.example.com', audience: 'validation' }],
  });
  const providers = await client.list('identity_providers');
  const identityProviders = providers.map(platformAccessIdentityProvider);
  if (
    !input.identityProviderIds.length ||
    !input.policyIds.length ||
    input.identityProviderIds.length > 16 ||
    input.policyIds.length > 16 ||
    new Set(input.identityProviderIds).size !== input.identityProviderIds.length ||
    new Set(input.policyIds).size !== input.policyIds.length
  ) {
    throw new PlatformAccessPolicyRejectedError(
      'platform: Select explicit identity providers and company policies for Access.',
    );
  }
  if (
    input.identityProviderIds.some(
      (id) => !identityProviders.some((provider) => provider.id === id),
    )
  ) {
    throw new PlatformAccessPolicyRejectedError(
      'platform: A selected Access identity provider is unavailable in this account.',
    );
  }
  const policies = await verifySelectedAccessPolicies(
    client,
    input.policyIds,
    input.identityProviderIds,
    providers,
  );
  return { teamDomain, identityProviders, policies };
}

export async function provisionPlatformAccess(
  client: PlatformAccessClient,
  input: PlatformAccessProvisionInput,
  previous: PlatformAccessCheckpoint,
  save: (state: PlatformAccessCheckpoint) => void,
): Promise<PlatformAccessProvisionResult> {
  const inspected = await inspectPlatformAccess(client, input);
  const origins = [
    ...new Set(
      [input.apiUrl, input.proxyUrl, ...(input.additionalOrigins ?? [])].map((value) => {
        const url = new URL(value);
        if (url.origin !== value || url.protocol !== 'https:') {
          throw new Error(
            'platform: Access requires exact HTTPS origins without credentials, paths, or query strings.',
          );
        }
        return url.origin;
      }),
    ),
  ];
  const state = structuredClone(previous);
  if (
    state.version !== 1 ||
    state.accountId !== input.accountId ||
    state.installationId !== input.installationId ||
    !/^[a-f0-9]{32}$/.test(state.nonce)
  ) {
    throw new Error('platform: Access recovery data belongs to a different installation.');
  }
  save(state);
  const policies = input.policyIds.map((id, index) => ({ id, precedence: index + 1 }));
  const inventory = await client.list('apps');
  const tokenInventory = input.protection ? await client.list('service_tokens') : [];
  if (input.protection?.applicationId && !input.serviceToken) {
    throw new Error(
      'platform: Connecting an existing protection application requires its admitted service token.',
    );
  }
  if (input.serviceToken) {
    const token = tokenInventory.find((token) => token.id === input.serviceToken!.id);
    if (
      !token ||
      token.client_id !== input.serviceToken.clientId ||
      token.enabled === false ||
      (typeof token.expires_at === 'string' && Date.parse(token.expires_at) <= Date.now())
    ) {
      throw new Error(
        'platform: The selected Access service token is unavailable, expired, or belongs to another client.',
      );
    }
    const prior = state.resources['service-token'];
    state.resources['service-token'] = {
      id: input.serviceToken.id,
      name: text(token.name, 'service token name'),
      fingerprint: fingerprint({ origins }),
      pending: false,
      adopted: prior?.id === input.serviceToken.id ? prior.adopted : true,
    };
    save(state);
  }
  if (input.protection) {
    for (const app of inventory) {
      if (
        app.id === input.protection.applicationId ||
        app.id === state.resources.protection?.id ||
        app.name === state.resources.protection?.name
      ) {
        continue;
      }
      if (platformAccessOverlapsOrigins(app, origins)) {
        throw new Error(
          'platform: An existing Access application overlaps a platform endpoint. Connect or reconcile it explicitly before provisioning protection.',
        );
      }
    }
  }
  const output: PlatformAccessProvisionResult = { resources: [] };

  const application = async (
    key: string,
    expected: ObjectValue,
    existingId?: string,
  ): Promise<ObjectValue> => {
    if (existingId) {
      const found = object(
        await client.get(`apps/${encodeURIComponent(existingId)}`),
        'Access application',
      );
      if (found.id !== existingId) {
        throw new Error('platform: Access returned a different application ID.');
      }
      state.resources[key] = {
        id: existingId,
        name: text(found.name, 'application name'),
        fingerprint: fingerprint(expected),
        pending: true,
        adopted: true,
      };
      save(state);
      return found;
    }
    const desiredHash = fingerprint(expected);
    let checkpoint = state.resources[key];
    if (checkpoint && checkpoint.fingerprint !== desiredHash) {
      throw new Error(
        'platform: Access setup changed after provisioning started. Connect the existing application explicitly rather than overwriting it.',
      );
    }
    if (checkpoint?.id) {
      const found = object(
        await client.get(`apps/${encodeURIComponent(checkpoint.id)}`),
        'Access application',
      );
      if (found.id !== checkpoint.id || found.name !== checkpoint.name) {
        throw new Error('platform: The recorded Access application changed ownership identity.');
      }
      return found;
    }
    if (checkpoint?.pending) {
      const matching = inventory.filter((app) => app.name === checkpoint!.name);
      if (matching.length !== 1) {
        throw new Error(
          'platform: An Access application creation has an uncertain outcome. Inspect Cloudflare and connect the existing application; no creation was retried.',
        );
      }
      checkpoint.id = text(matching[0]!.id, 'application ID');
      save(state);
      return object(
        await client.get(`apps/${encodeURIComponent(checkpoint.id)}`),
        'Access application',
      );
    }
    const name =
      `void-${input.installationId}-${key}`.slice(0, 90) + '-' + state.nonce.slice(0, 16);
    if (inventory.some((app) => app.name === name)) {
      throw new Error(
        'platform: An Access application with this installation identity already exists. Connect it explicitly; no duplicate was created.',
      );
    }
    checkpoint = { name, fingerprint: desiredHash, pending: true };
    state.resources[key] = checkpoint;
    save(state);
    try {
      const created = object(
        await client.create('apps', { ...expected, name }),
        'Access application',
      );
      checkpoint.id = text(created.id, 'application ID');
      if (created.saas_app) {
        const oidc = object(created.saas_app, 'OIDC application');
        checkpoint.clientId = text(oidc.client_id, 'OIDC client ID');
        checkpoint.clientSecret =
          typeof oidc.client_secret === 'string' ? oidc.client_secret : undefined;
      }
      save(state);
      return object(
        await client.get(`apps/${encodeURIComponent(checkpoint.id)}`),
        'Access application',
      );
    } catch (error) {
      if (platformAccessCreateRejected(error)) {
        checkpoint.pending = false;
        save(state);
      }
      throw error;
    }
  };

  const completeApplication = (key: string, app: ObjectValue) => {
    const checkpoint = state.resources[key];
    if (!checkpoint?.id || checkpoint.id !== app.id || checkpoint.name !== app.name) {
      throw new Error('platform: The verified Access application changed ownership identity.');
    }
    checkpoint.pending = false;
    save(state);
  };

  if (input.login) {
    const key = `login-${input.login.id}`;
    const expected = {
      type: 'saas',
      allowed_idps: [...input.identityProviderIds],
      auto_redirect_to_identity: input.identityProviderIds.length === 1,
      policies,
      session_duration: '12h',
      saas_app: {
        auth_type: 'oidc',
        redirect_uris: [`${input.apiUrl}/auth/callback`],
        grant_types: ['authorization_code_with_pkce'],
        allow_pkce_without_client_secret: false,
        scopes: input.login.requiredGroups?.length
          ? ['openid', 'email', 'profile', 'groups']
          : ['openid', 'email', 'profile'],
      },
    };
    const app = await application(key, expected, input.login.applicationId);
    await verifyPlatformAccessApplication(client, input, app, 'saas');
    const oidc = object(app.saas_app, 'OIDC configuration');
    if (
      oidc.auth_type !== 'oidc' ||
      !sameSet(ids(oidc.redirect_uris), [`${input.apiUrl}/auth/callback`]) ||
      !sameSet(ids(oidc.grant_types), ['authorization_code_with_pkce']) ||
      oidc.allow_pkce_without_client_secret === true
    ) {
      throw new Error('platform: Access OIDC redirect or flow settings do not match Void.');
    }
    const clientId = text(oidc.client_id, 'OIDC client ID');
    const clientSecret = input.login.clientSecret ?? state.resources[key]?.clientSecret;
    if (!clientSecret) {
      throw new Error(
        'platform: The Access application exists but its client secret was not recovered. Supply its secret explicitly; no duplicate application was created.',
      );
    }
    output.login = {
      configuration: parsePlatformLoginConfiguration({
        id: input.login.id,
        kind: 'cloudflare-access',
        label: input.login.label,
        issuer: `${inspected.teamDomain}/cdn-cgi/access/sso/oidc/${clientId}`,
        clientId,
        requiredGroups: input.login.requiredGroups ?? [],
      }),
      clientSecret,
    };
    completeApplication(key, app);
  }

  if (input.protection) {
    let service = input.serviceToken;
    const tokenKey = 'service-token';
    if (!service) {
      let saved = state.resources[tokenKey];
      if (!saved) {
        saved = {
          name: `void-${input.installationId}-access-probes-${state.nonce.slice(0, 16)}`,
          fingerprint: fingerprint({ origins }),
          pending: true,
        };
        state.resources[tokenKey] = saved;
        save(state);
        if (tokenInventory.some((token) => token.name === saved!.name)) {
          throw new Error(
            'platform: An Access service token for this installation already exists. Supply its credentials explicitly; no duplicate was created.',
          );
        }
        const created = object(
          await client.create('service_tokens', { name: saved.name, duration: '8760h' }),
          'Access service token',
        );
        saved.id = text(created.id, 'service token ID');
        saved.clientId = text(created.client_id, 'service token client ID');
        saved.clientSecret = text(created.client_secret, 'service token secret');
        saved.pending = false;
        save(state);
      }
      if (!saved.id || !saved.clientId || !saved.clientSecret) {
        const tokens = await client.list('service_tokens');
        const found = tokens.filter((token) => token.name === saved!.name);
        if (found.length === 1) {
          saved.id = text(found[0]!.id, 'service token ID');
          save(state);
        }
        throw new Error(
          'platform: Access service-token creation has an uncertain outcome or its secret was lost. Supply an existing admitted service token; no creation was retried.',
        );
      }
      if (saved.fingerprint !== fingerprint({ origins })) {
        throw new Error(
          'platform: The saved Access service token belongs to different platform origins. Connect the intended service token explicitly.',
        );
      }
      service = { id: saved.id, clientId: saved.clientId, clientSecret: saved.clientSecret };
    }
    const expected = {
      type: 'self_hosted',
      domain: new URL(input.apiUrl).hostname,
      destinations: origins.map((origin) => ({ type: 'public', uri: new URL(origin).hostname })),
      allowed_idps: [...input.identityProviderIds],
      auto_redirect_to_identity: input.identityProviderIds.length === 1,
      session_duration: '12h',
      policies: [
        ...policies,
        {
          name: 'Void installer and CI',
          decision: 'non_identity',
          precedence: 0,
          include: [{ service_token: { token_id: service.id } }],
        },
      ],
    };
    const app = await application('protection', expected, input.protection.applicationId);
    await verifyPlatformAccessApplication(client, input, app, 'self_hosted', service.id);
    const covered = platformAccessPublicDestinations(app);
    if (origins.some((origin) => !covered.includes(new URL(origin).hostname))) {
      throw new Error(
        'platform: Access must protect both the API and proxy origins without path exclusions.',
      );
    }
    const audience = text(app.aud, 'application audience');
    output.protection = parsePlatformAccessProtection({
      teamDomain: inspected.teamDomain,
      applications: origins.map((origin) => ({ origin, audience })),
    })!;
    output.credentials = Object.fromEntries(
      origins.map((origin) => [
        origin,
        { CF_ACCESS_CLIENT_ID: service.clientId, CF_ACCESS_CLIENT_SECRET: service.clientSecret },
      ]),
    );
    completeApplication('protection', app);
    const savedService = state.resources[tokenKey];
    if (savedService?.id === service.id) {
      savedService.pending = false;
      save(state);
    }
  }
  output.resources = Object.entries(state.resources).flatMap(([key, value]) =>
    value.id ? [{ key, id: value.id, name: value.name, adopted: value.adopted === true }] : [],
  );
  return output;
}

export async function verifyPlatformAccessApplication(
  client: PlatformAccessClient,
  input: Pick<PlatformAccessProvisionInput, 'identityProviderIds' | 'policyIds'>,
  app: ObjectValue,
  type: string,
  machineId?: string,
): Promise<void> {
  if (app.type !== type || !sameSet(ids(app.allowed_idps), input.identityProviderIds)) {
    throw new Error(
      'platform: Access application identity-provider configuration does not match the reviewed plan.',
    );
  }
  const currentPolicies = await client.list(
    `apps/${encodeURIComponent(text(app.id, 'application ID'))}/policies`,
  );
  await verifyCompanyAccessPolicies(client, currentPolicies, input.identityProviderIds);
  const allowIds = currentPolicies
    .filter((policy) => policy.decision === 'allow' || policy.decision === 'deny')
    .map((policy) => text(policy.id, 'policy ID'));
  if (!sameSet(allowIds, input.policyIds)) {
    throw new Error(
      'platform: Access application policies do not match the reviewed company policies.',
    );
  }
  for (const policy of currentPolicies.filter((policy) => policy.decision === 'non_identity')) {
    const includes = Array.isArray(policy.include) ? policy.include : [];
    if (
      !machineId ||
      includes.length !== 1 ||
      object(includes[0], 'service policy').service_token === undefined ||
      object(object(includes[0], 'service policy').service_token, 'service token rule').token_id !==
        machineId
    ) {
      throw new Error('platform: Access application contains an unexpected machine policy.');
    }
  }
  if (machineId && !currentPolicies.some((policy) => policy.decision === 'non_identity')) {
    throw new Error('platform: The platform service token is not admitted by Access.');
  }
}
