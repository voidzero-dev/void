import { isPrintableText, record } from './validate.ts';

/** Platform login and perimeter configuration are independent of app authentication. */
export const PLATFORM_LOGIN_KINDS = ['github', 'google', 'oidc', 'cloudflare-access'] as const;
export type PlatformLoginKind = (typeof PLATFORM_LOGIN_KINDS)[number];

export function isPlatformLoginKind(value: unknown): value is PlatformLoginKind {
  return PLATFORM_LOGIN_KINDS.some((kind) => kind === value);
}

export type PlatformLoginConfiguration = Readonly<{
  id: string;
  kind: PlatformLoginKind;
  label: string;
  clientId: string;
  /** Exact OIDC issuer; GitHub does not use OIDC. */
  issuer?: string;
  /** Google Workspace hosted domains, checked against the signed hd claim. */
  allowedDomains: ReadonlyArray<string>;
  /** An identity must belong to at least one configured group. */
  requiredGroups: ReadonlyArray<string>;
}>;

export type PlatformLoginDescriptor = Readonly<{
  id: string;
  kind: PlatformLoginKind;
  label: string;
}>;

export type PlatformAccessProtection = Readonly<{
  teamDomain: string;
  /** Each externally reachable platform origin has its own expected application audience. */
  applications: ReadonlyArray<Readonly<{ origin: string; audience: string }>>;
}>;

/** Operator-side coverage verification, bound to one administrator and settings revision. */
export function platformProtectionProofMessage(input: {
  installationId: string;
  origin: string;
  userId: string;
  sessionId: string;
  revision: number;
  lifecycleVersion: string;
  protection: PlatformAccessProtection | null;
  expiresAt: string;
}): string {
  return `void-platform-protection-v1\n${JSON.stringify({
    installationId: input.installationId,
    origin: input.origin,
    userId: input.userId,
    sessionId: input.sessionId,
    revision: input.revision,
    lifecycleVersion: input.lifecycleVersion,
    protection: parsePlatformAccessProtection(input.protection),
    expiresAt: input.expiresAt,
  })}`;
}

export type PlatformAdmissionPolicy =
  | Readonly<{ mode: 'restricted' | 'public' }>
  | Readonly<{
      mode: 'company';
      /** Explicitly trusted connections whose own configured restrictions must pass. */
      connections: ReadonlyArray<string>;
      /** A verified human Access identity qualifies, independently of the login method. */
      access: boolean;
    }>;

/** One persisted grant used by invited/allowlisted platform signup. */
export type PlatformSignupAllowlistEntry =
  | Readonly<{
      type: 'github' | 'email';
      pattern: string;
      note?: string;
    }>
  | Readonly<{
      type: 'identity';
      /** Stable login connection namespace. */
      connectionId: string;
      /** Exact, case-sensitive provider subject. */
      subject: string;
      note?: string;
    }>;

export type PlatformSignupIdentity = Readonly<{
  connectionId: string;
  subject: string;
  provider: string;
  login: string;
  /** Only pass a provider email after its verification claim has been validated. */
  email: string | null;
}>;

export function parsePlatformSignupAllowlistEntry(value: unknown): PlatformSignupAllowlistEntry {
  const entry = record(value, 'Signup allowlist entry');
  const note = entry.note;
  if (note !== undefined && (typeof note !== 'string' || note.length > 1000)) {
    throw new Error('Signup allowlist notes must be strings of at most 1000 characters.');
  }
  const optionalNote = note === undefined ? {} : { note };
  if (entry.type === 'identity') {
    const connectionId = parsePlatformLoginId(entry.connectionId);
    if (
      typeof entry.subject !== 'string' ||
      entry.subject.length === 0 ||
      entry.subject.length > 255
    ) {
      throw new Error('Identity subjects must be nonempty strings of at most 255 characters.');
    }
    return { type: 'identity', connectionId, subject: entry.subject, ...optionalNote };
  }
  if (entry.type !== 'github' && entry.type !== 'email') {
    throw new Error('Signup allowlist entry type must be github, email, or identity.');
  }
  if (
    typeof entry.pattern !== 'string' ||
    !entry.pattern ||
    entry.pattern.length > 320 ||
    /[\s,]/.test(entry.pattern)
  ) {
    throw new Error(
      'Signup allowlist patterns must be nonempty strings of at most 320 characters.',
    );
  }
  return { type: entry.type, pattern: entry.pattern, ...optionalNote };
}

/** Match one verified login identity against persisted signup grants. */
export function isPlatformSignupAllowed(
  identity: PlatformSignupIdentity,
  entries: ReadonlyArray<PlatformSignupAllowlistEntry>,
): boolean {
  return entries.some((entry) => {
    if (entry.type === 'identity') {
      return entry.connectionId === identity.connectionId && entry.subject === identity.subject;
    }
    if (entry.type === 'github') {
      return (
        identity.provider === 'github' &&
        entry.pattern.toLowerCase() === identity.login.toLowerCase()
      );
    }
    if (!identity.email) {
      return false;
    }
    if (entry.pattern.startsWith('*@')) {
      return identity.email.toLowerCase().endsWith(entry.pattern.slice(1).toLowerCase());
    }
    return entry.pattern.toLowerCase() === identity.email.toLowerCase();
  });
}

export type PlatformAuthenticationSetup = Readonly<{
  connections: ReadonlyArray<
    Readonly<{ configuration: PlatformLoginConfiguration; clientSecret: string }>
  >;
  administratorConnectionId: string;
  bootstrapCredentialHash: string;
  admission: PlatformAdmissionPolicy;
  protection: PlatformAccessProtection | null;
  resetPending?: boolean;
}>;

export function parsePlatformAuthenticationSetup(value: unknown): PlatformAuthenticationSetup {
  const input = record(value, 'Authentication setup');
  if (
    !Array.isArray(input.connections) ||
    input.connections.length === 0 ||
    input.connections.length > 32
  ) {
    throw new Error('Authentication setup requires between 1 and 32 connections.');
  }
  const connections = input.connections.map((value) => {
    const entry = record(value, 'Login connection');
    const { clientSecret } = entry;
    assertPrintableText(clientSecret, 'Client secret', 8192);
    return {
      configuration: parsePlatformLoginConfiguration(entry.configuration),
      clientSecret,
    };
  });
  if (new Set(connections.map((entry) => entry.configuration.id)).size !== connections.length) {
    throw new Error('Authentication setup connection IDs must be unique.');
  }
  const administratorConnectionId = parsePlatformLoginId(input.administratorConnectionId);
  if (!connections.some((entry) => entry.configuration.id === administratorConnectionId)) {
    throw new Error('The administrator login method must be included in setup.');
  }
  if (
    typeof input.bootstrapCredentialHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.bootstrapCredentialHash)
  ) {
    throw new Error('A SHA-256 bootstrap credential hash is required.');
  }
  const admission = parsePlatformAdmissionPolicy(input.admission);
  const protection = parsePlatformAccessProtection(input.protection ?? null);
  validatePlatformAdmissionPolicy(
    admission,
    connections.map((entry) => entry.configuration),
    protection,
  );
  if (input.resetPending !== undefined && typeof input.resetPending !== 'boolean') {
    throw new Error('resetPending must be a boolean.');
  }
  return {
    connections,
    administratorConnectionId,
    bootstrapCredentialHash: input.bootstrapCredentialHash,
    admission,
    protection,
    ...(input.resetPending === true ? { resetPending: true } : {}),
  };
}

export const DEFAULT_PLATFORM_SESSION_SECONDS: number = 30 * 24 * 60 * 60;
export const GOOGLE_OIDC_ISSUER = 'https://accounts.google.com';
export const PLATFORM_AUTH_SETUP_PROOF_PREFIX = 'void.platform.auth.setup.v1';

function assertPrintableText(
  value: unknown,
  name: string,
  maximum: number,
): asserts value is string {
  if (!isPrintableText(value, maximum)) {
    throw new Error(`${name} must be a nonempty string of at most ${maximum} characters.`);
  }
}

function string(value: unknown, name: string, maximum = 512): string {
  assertPrintableText(value, name, maximum);
  return value.trim();
}

function strings(value: unknown, name: string, maximum = 100): Array<string> {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${name} must be an array of at most ${maximum} strings.`);
  }
  const result = value.map((entry) => string(entry, name));
  if (new Set(result).size !== result.length) {
    throw new Error(`${name} must not contain duplicates.`);
  }
  return result;
}

export function parsePlatformLoginId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(
      'Login connection IDs must start with a letter and use 1–64 lowercase letters, digits, or hyphens.',
    );
  }
  return value;
}

/** HTTPS syntax validation; outbound network policy must additionally validate resolved endpoints. */
export function parsePlatformIdentityUrl(value: unknown, name: string, originOnly = false): string {
  const input = string(value, name, 2048);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (originOnly && url.pathname !== '/')
  ) {
    throw new Error(
      `${name} must be a credential-free HTTPS ${originOnly ? 'origin' : 'URL'} without query or fragment.`,
    );
  }
  // OIDC issuer strings are compared exactly, including a significant trailing slash.
  return originOnly ? url.origin : input;
}

export function parsePlatformLoginDescriptor(value: unknown): PlatformLoginDescriptor {
  const entry = record(value, 'Login connection');
  const id = parsePlatformLoginId(entry.id);
  const { kind } = entry;
  if (!isPlatformLoginKind(kind)) {
    throw new Error('Login kind must be github, google, oidc, or cloudflare-access.');
  }
  if ((id === 'github' || id === 'google') && id !== kind) {
    throw new Error(`Connection ID ${id} is reserved for ${id} login.`);
  }
  if ((kind === 'github' || kind === 'google') && id !== kind) {
    throw new Error(`${kind} uses the fixed connection ID ${kind}.`);
  }
  return { id, kind, label: string(entry.label, 'Login label', 100) };
}

export function parsePlatformLoginConfiguration(value: unknown): PlatformLoginConfiguration {
  const entry = record(value, 'Login configuration');
  const descriptor = parsePlatformLoginDescriptor(entry);
  const clientId = string(entry.clientId, 'Client ID');
  const allowedDomains = strings(entry.allowedDomains ?? [], 'Allowed domains').map((domain) => {
    const normalized = domain.toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)) {
      throw new Error('Allowed domains must be exact domain names, without wildcards.');
    }
    return normalized;
  });
  if (new Set(allowedDomains).size !== allowedDomains.length) {
    throw new Error('Allowed domains must not contain duplicates.');
  }
  const requiredGroups = strings(entry.requiredGroups ?? [], 'Required groups');
  if (descriptor.kind !== 'google' && allowedDomains.length > 0) {
    throw new Error('Workspace domain restrictions are only supported by Google login.');
  }
  if ((descriptor.kind === 'github' || descriptor.kind === 'google') && requiredGroups.length > 0) {
    throw new Error('Group restrictions require an OIDC or Cloudflare Access connection.');
  }
  let issuer: string | undefined;
  if (descriptor.kind === 'google') {
    if (entry.issuer !== undefined && entry.issuer !== GOOGLE_OIDC_ISSUER) {
      throw new Error('Google login uses the Google issuer.');
    }
    issuer = GOOGLE_OIDC_ISSUER;
  } else if (descriptor.kind === 'github') {
    if (entry.issuer !== undefined) {
      throw new Error('GitHub login does not accept an OIDC issuer.');
    }
  } else {
    issuer = parsePlatformIdentityUrl(entry.issuer, 'OIDC issuer');
    if (descriptor.kind === 'cloudflare-access') {
      const url = new URL(issuer);
      const prefix = '/cdn-cgi/access/sso/oidc/';
      if (
        !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(url.hostname) ||
        url.port ||
        !url.pathname.startsWith(prefix) ||
        decodeURIComponent(url.pathname.slice(prefix.length).replace(/\/$/, '')) !== clientId
      ) {
        throw new Error(
          'Cloudflare Access login requires its application issuer URL and matching client ID. Use generic OIDC for another issuer.',
        );
      }
    }
  }
  return { ...descriptor, clientId, ...(issuer ? { issuer } : {}), allowedDomains, requiredGroups };
}

export function parsePlatformAccessProtection(value: unknown): PlatformAccessProtection | null {
  if (value === null) {
    return null;
  }
  const entry = record(value, 'Access protection');
  const teamDomain = parsePlatformIdentityUrl(entry.teamDomain, 'Access team domain', true);
  const host = new URL(teamDomain).hostname;
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(host) ||
    new URL(teamDomain).port
  ) {
    throw new Error('Access team domain must be an HTTPS cloudflareaccess.com team origin.');
  }
  if (
    !Array.isArray(entry.applications) ||
    entry.applications.length === 0 ||
    entry.applications.length > 20
  ) {
    throw new Error('Access protection requires between 1 and 20 protected origins.');
  }
  const applications = entry.applications.map((value) => {
    const application = record(value, 'Access application');
    return {
      origin: parsePlatformIdentityUrl(application.origin, 'Protected origin', true),
      audience: string(application.audience, 'Access application audience'),
    };
  });
  if (new Set(applications.map((app) => app.origin)).size !== applications.length) {
    throw new Error('Each protected origin must have exactly one Access application.');
  }
  return { teamDomain, applications };
}

export function parsePlatformAdmissionPolicy(value: unknown): PlatformAdmissionPolicy {
  const entry = record(value, 'Admission policy');
  if (entry.mode === 'restricted' || entry.mode === 'public') {
    return { mode: entry.mode };
  }
  if (entry.mode !== 'company' || typeof entry.access !== 'boolean') {
    throw new Error('Admission policy must select restricted, company, or public signup.');
  }
  const connections = strings(entry.connections, 'Company connections').map(parsePlatformLoginId);
  if (!entry.access && connections.length === 0) {
    throw new Error('Company admission requires a trusted connection or Access protection.');
  }
  return { mode: 'company', connections, access: entry.access };
}

/** Run inside the settings mutation transaction, using the resulting enabled connections. */
export function validatePlatformAdmissionPolicy(
  policy: PlatformAdmissionPolicy,
  enabledConnections: ReadonlyArray<PlatformLoginConfiguration>,
  protection: PlatformAccessProtection | null,
): void {
  if (policy.mode !== 'company') {
    return;
  }
  if (policy.access && !protection) {
    throw new Error('Company admission through Access requires enabled protection.');
  }
  for (const id of policy.connections) {
    const connection = enabledConnections.find((entry) => entry.id === id);
    if (!connection) {
      throw new Error(`Company admission requires enabled connection ${id}.`);
    }
    if (
      connection.kind === 'github' ||
      (connection.kind === 'google' && connection.allowedDomains.length === 0)
    ) {
      throw new Error('Unrestricted social login does not establish company membership.');
    }
  }
}
