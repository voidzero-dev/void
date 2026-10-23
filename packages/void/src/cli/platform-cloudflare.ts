import { createHash, randomUUID } from 'node:crypto';
import { formatUrl } from './output.ts';
import { resolvePinnedApiBaseUrl } from './provision.ts';

type CloudflareEnvelope<T> = Readonly<{
  errors?: ReadonlyArray<{ code?: number; message?: string }>;
  result?: T;
  result_info?: {
    cursor?: string;
    page?: number;
    per_page?: number;
    total_pages?: number;
  };
  success?: boolean;
}>;

export class PlatformCloudflareApiError extends Error {
  readonly status: number;
  readonly requestPath?: string;

  constructor(message: string, status: number, requestPath?: string) {
    super(message);
    this.name = 'PlatformCloudflareApiError';
    this.status = status;
    this.requestPath = requestPath;
  }
}

export class PlatformCloudflarePrerequisiteError extends PlatformCloudflareApiError {
  override readonly cause: PlatformCloudflareApiError;

  constructor(message: string, cause: PlatformCloudflareApiError) {
    super(message, cause.status, cause.requestPath);
    this.name = 'PlatformCloudflarePrerequisiteError';
    this.cause = cause;
  }
}

export class PlatformWorkerCustomDomainsChangedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlatformWorkerCustomDomainsChangedError';
  }
}

export class PlatformWorkerRoutesChangedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlatformWorkerRoutesChangedError';
  }
}

/**
 * The runtime token cannot read the shared email zone. The operator can add
 * the permission to the same token, so callers keep its saved value.
 */
export class PlatformRuntimeTokenEmailPermissionError extends Error {
  /** Cloudflare answered HTTP 401 at least once: it did not accept the token. */
  readonly tokenNotValid: boolean;

  constructor(message: string, tokenNotValid: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlatformRuntimeTokenEmailPermissionError';
    this.tokenNotValid = tokenNotValid;
  }
}

export type CloudflareAccount = Readonly<{ id: string; name: string }>;
export type CloudflareNamedResource = Readonly<{
  /** When Cloudflare created it, where the API reports that. */
  createdAt?: string;
  fingerprint?: string;
  id: string;
  name: string;
}>;
export type CloudflareHyperdriveOrigin = Readonly<{
  accessClientId?: string;
  database: string;
  host: string;
  /** Tunnel-backed origins get their database port from the tunnel service. */
  port: number | null;
  scheme: 'postgresql';
  user: string | null;
}>;
export type CloudflareHyperdriveConfig = CloudflareNamedResource &
  Readonly<{ origin: CloudflareHyperdriveOrigin; cachingDisabled?: boolean }>;
export type CloudflareDnsRecord = CloudflareNamedResource &
  Readonly<{
    content: string;
    proxied: boolean;
    type: string;
  }>;
export type CloudflareZone = Readonly<{
  id: string;
  name: string;
  nameServers: ReadonlyArray<string>;
  status: string;
}>;
export type CloudflareWorkerDomain = Readonly<{
  hostname: string;
  id: string;
  service: string;
  zoneName?: string;
}>;
export type CloudflareWorkerCustomDomainOrigin = Readonly<{
  enabled?: boolean;
  hostname: string;
  previewsEnabled?: boolean;
  zoneId?: string;
  zoneName?: string;
}>;
export type CloudflareWorkerRoute = Readonly<{
  id: string;
  pattern: string;
  script: string | null;
}>;
export type CloudflareWorkerServiceRoute = Readonly<{
  pattern: string;
  zoneName: string;
}>;
/** What still depends on a Worker, as `wrangler delete` reads it before forcing. */
export type CloudflareWorkerDependents = Readonly<{
  /**
   * Workers that use it through a service binding, a Durable Object namespace
   * it implements, a dispatch namespace outbound, or as their tail Worker.
   */
  workers: ReadonlyArray<string>;
  /** A Pages project binds to it; Cloudflare does not name the project. */
  pagesFunction: boolean;
}>;
export type CloudflareQueueConsumer = Readonly<{
  id: string;
  /** Worker that consumes the Queue (`script_name`); null for an HTTP pull consumer. */
  script: string | null;
}>;
export type PlatformAccessResourceKind = 'application' | 'service-token';
export type CloudflareEmailRoutingCatchAll = Readonly<{
  enabled: boolean;
  /** The Worker that receives mail; null unless its only action is one Worker. */
  workerName: string | null;
}>;
export type CloudflareEmailRoutingRule = CloudflareEmailRoutingCatchAll & Readonly<{ id: string }>;
export type PlatformManagedWorkerTraffic = Readonly<{
  customDomains: ReadonlyArray<Readonly<{ hostname: string; service: string }>>;
  routes: ReadonlyArray<Readonly<{ pattern: string; script: string }>>;
}>;

export type PlatformRuntimeTokenPreflightClient = Pick<
  PlatformCloudflareClient,
  'listHyperdriveConfigs' | 'request'
>;

export async function verifyPlatformRuntimeTokenPermissions(
  client: PlatformRuntimeTokenPreflightClient,
  input: {
    accountId: string;
    applicationDomain: string;
    customDomains: boolean;
    /** The shared email zone, only when platform email is on. */
    emailZoneId?: string;
    zoneId: string | null;
  },
): Promise<void> {
  try {
    await client.listHyperdriveConfigs(input.accountId);
  } catch (error) {
    throw runtimeTokenPreflightError('Account → Hyperdrive → Write', error);
  }

  if (input.emailZoneId) {
    await verifyPlatformRuntimeTokenEmailPermissions(client, {
      accountId: input.accountId,
      zoneId: input.emailZoneId,
    });
  }

  if (!input.zoneId) {
    return;
  }

  const probeUrl = `https://${input.applicationDomain}/.well-known/void/runtime-token-preflight-${randomUUID()}`;
  try {
    await client.request(`/zones/${encodeURIComponent(input.zoneId)}/purge_cache`, {
      body: JSON.stringify({ files: [probeUrl] }),
      method: 'POST',
    });
  } catch (error) {
    throw runtimeTokenPreflightError('Zone → Cache Purge → Purge', error);
  }

  if (input.customDomains) {
    try {
      await client.request(
        `/zones/${encodeURIComponent(input.zoneId)}/custom_hostnames?per_page=1`,
      );
    } catch (error) {
      throw runtimeTokenPreflightError('Zone → SSL and Certificates → Edit', error);
    }
  }
}

/**
 * Shared email setup uses the runtime token after the platform pauses traffic.
 * Read-only requests find a missing Email Routing permission before that. A
 * read cannot prove Edit access. Email Sending is not checked, because its
 * answer depends on the account plan.
 */
export async function verifyPlatformRuntimeTokenEmailPermissions(
  client: Pick<PlatformCloudflareClient, 'request'>,
  input: {
    accountId: string;
    zoneId: string;
    /**
     * The token is the one saved on this machine, and the run does not send
     * it to the platform Workers. They can use a different token.
     */
    savedToken?: boolean;
  },
): Promise<void> {
  const zone = `/zones/${encodeURIComponent(input.zoneId)}`;
  const probes = [
    ['Zone → Zone → Read', zone],
    ['Zone → Zone Settings → Edit', `${zone}/email/routing`],
    ['Zone → Email Routing Rules → Edit', `${zone}/email/routing/rules?per_page=5`],
    [
      'Account → Email Routing Addresses → Edit',
      `/accounts/${encodeURIComponent(input.accountId)}/email/routing/addresses?per_page=5`,
    ],
  ] as const;
  const missing: Array<string> = [];
  let denial: PlatformCloudflareApiError | undefined;
  let tokenNotValid = false;
  for (const [permission, path] of probes) {
    try {
      await client.request(path);
    } catch (error) {
      // Only an authorization answer shows a missing permission. A rate limit,
      // a Cloudflare outage or a network failure does not stop the command.
      if (
        error instanceof PlatformCloudflareApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        missing.push(permission);
        denial ??= error;
        // A token that is not valid gets 403 on the zone read, but 401 on
        // the Email Routing reads. A valid token without access gets 403.
        tokenNotValid ||= error.status === 401;
      }
    }
  }
  if (denial) {
    const denied = `Cloudflare denied: ${missing.join(', ')} (HTTP ${denial.status}).`;
    throw new PlatformRuntimeTokenEmailPermissionError(
      input.savedToken
        ? `platform: The runtime API token saved on this machine cannot use platform email. ${denied} Void checked this token because VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN is not set. If the platform uses a different runtime token, set VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN to that token, and Void checks that token instead. Otherwise, check that the zone permissions of the saved token include the email zone ${input.zoneId}. To add a missing permission, edit the token in the Cloudflare dashboard. The token value stays the same. Then run the command again.`
        : `platform: The runtime API token cannot use platform email. ${denied} Check that the token is valid and that its zone permissions include the email zone ${input.zoneId}. To add a missing permission, edit the token in the Cloudflare dashboard. The token value stays the same. Or set VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN to a valid token that has these permissions. Then run the command again.`,
      tokenNotValid,
      { cause: denial },
    );
  }
}

function runtimeTokenPreflightError(permission: string, cause: unknown): Error {
  const status = cause instanceof PlatformCloudflareApiError ? cause.status : null;
  const message =
    status === 401 || status === 403
      ? `Cloudflare denied the runtime-token check (HTTP ${status}). Check that the token is valid, scoped to this account, and includes ${permission}.`
      : status === 429
        ? `Cloudflare rate-limited the runtime-token check for ${permission} (HTTP 429). Retry shortly; this does not mean the token is missing a permission.`
        : `Could not complete the runtime-token check for ${permission}${status === null ? '' : ` (Cloudflare HTTP ${status})`}. Retry the check; this failure does not establish that a permission is missing.`;
  return new Error(`platform: ${message}`, { cause });
}

export class PlatformCloudflareClient {
  readonly apiBaseUrl: string;
  readonly #fetcher: typeof fetch;
  readonly #token: string;
  readonly #aiGatewayClient?: PlatformCloudflareClient;

  constructor(
    token: string,
    options?: { apiBase?: string; fetcher?: typeof fetch; aiGatewayToken?: string },
  ) {
    if (!token) {
      throw new Error(
        'platform: CLOUDFLARE_API_TOKEN is required. The installed control plane also uses this scoped token to provision app resources.',
      );
    }
    this.#token = token;
    this.apiBaseUrl = (options?.apiBase ?? resolvePinnedApiBaseUrl()).replace(/\/+$/, '');
    this.#fetcher = options?.fetcher ?? fetch;
    if (options?.aiGatewayToken) {
      this.#aiGatewayClient = new PlatformCloudflareClient(options.aiGatewayToken, {
        apiBase: this.apiBaseUrl,
        fetcher: this.#fetcher,
      });
    }
  }

  /** Keep operator auth for infrastructure; use the existing runtime credential only for AI Gateway. */
  withAiGatewayToken(token: string): PlatformCloudflareClient {
    return new PlatformCloudflareClient(this.#token, {
      apiBase: this.apiBaseUrl,
      fetcher: this.#fetcher,
      aiGatewayToken: token,
    });
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.#requestEnvelope<T>(path, init)).result;
  }

  async #requestEnvelope<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ result: T; resultInfo: CloudflareEnvelope<T>['result_info'] }> {
    const response = await this.#fetcher(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.#token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(30_000),
      redirect: 'manual',
    });
    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = (await response.json()) as CloudflareEnvelope<T>;
    } catch {
      throw new PlatformCloudflareApiError(
        `Cloudflare returned a non-JSON response (HTTP ${response.status}).`,
        response.status,
        path.split('?')[0],
      );
    }
    if (!response.ok || envelope.success !== true || envelope.result === undefined) {
      const details = cloudflareErrorDetails(envelope, response.status);
      const requestPath = path.split('?')[0];
      const error = new PlatformCloudflareApiError(
        `Cloudflare API error: ${details} (HTTP ${response.status}; ${init?.method ?? 'GET'} ${requestPath}).`,
        response.status,
        requestPath,
      );
      const prerequisite = cloudflarePrerequisiteHelp(envelope, response.status, requestPath);
      if (prerequisite) {
        throw new PlatformCloudflarePrerequisiteError(prerequisite, error);
      }
      throw error;
    }
    return { result: envelope.result, resultInfo: envelope.result_info };
  }

  async listAccounts(): Promise<ReadonlyArray<CloudflareAccount>> {
    const entries: Array<{ id?: unknown; name?: unknown }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<ReadonlyArray<{ id?: unknown; name?: unknown }>>(
        `/accounts?page=${page}&per_page=50`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries.map((entry) => ({
      id: requiredString(entry.id, 'Cloudflare account id'),
      name: requiredString(entry.name, 'Cloudflare account name'),
    }));
  }

  async getWorkersSubdomain(accountId: string): Promise<string> {
    const setupUrl = `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/workers-and-pages`;
    let result: { subdomain?: unknown } | null;
    try {
      result = await this.request<{ subdomain?: unknown }>(
        `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
      );
    } catch (error) {
      const status = error instanceof PlatformCloudflareApiError ? error.status : null;
      const reason = status === null ? 'the request failed' : `HTTP ${status}`;
      const guidance =
        status === 401 || status === 403
          ? 'Check your Cloudflare login or API token permissions for this account, then rerun the command.'
          : status === 404
            ? `Open ${setupUrl} once to provision your account for Workers automatically, then retry the install.`
            : 'Rerun the command. If the dashboard already shows a subdomain, no Workers onboarding change is needed.';
      throw new Error(
        `platform: Could not read the workers.dev subdomain for account ${accountId} (${reason}). ${guidance}`,
        { cause: error },
      );
    }
    if (typeof result?.subdomain !== 'string' || result.subdomain.trim() === '') {
      throw new Error(
        `platform: This Cloudflare account does not have a workers.dev subdomain. Open ${setupUrl}, finish Workers onboarding, choose a subdomain, and rerun the command.`,
      );
    }
    return result.subdomain.trim();
  }

  async listAiGateways(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    if (this.#aiGatewayClient) {
      return this.#aiGatewayClient.listAiGateways(accountId);
    }
    const entries: Array<{ created_at?: unknown; id?: unknown }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<ReadonlyArray<{ created_at?: unknown; id?: unknown }>>(
        `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways?page=${page}&per_page=50`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries.map((entry) => ({
      ...withCreatedAt(entry.created_at),
      id: requiredString(entry.id, 'AI Gateway id'),
      name: requiredString(entry.id, 'AI Gateway id'),
    }));
  }

  async createAiGateway(accountId: string, id: string): Promise<CloudflareNamedResource> {
    if (this.#aiGatewayClient) {
      return this.#aiGatewayClient.createAiGateway(accountId, id);
    }
    const result = await this.request<{ id?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways`,
      {
        method: 'POST',
        body: JSON.stringify({
          cache_invalidate_on_update: false,
          cache_ttl: null,
          collect_logs: true,
          id,
          rate_limiting_interval: null,
          rate_limiting_limit: null,
        }),
      },
    );
    return {
      id: requiredString(result.id, 'AI Gateway id'),
      name: id,
    };
  }

  async findZone(accountId: string, name: string): Promise<CloudflareZone | null> {
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(name)}&per_page=50`,
    );
    const exact = result.find((zone) => zone.name === name);
    return exact ? parseZone(exact) : null;
  }

  async createZone(accountId: string, name: string): Promise<CloudflareZone> {
    return parseZone(
      await this.request<Record<string, unknown>>('/zones', {
        method: 'POST',
        body: JSON.stringify({ account: { id: accountId }, name, type: 'full' }),
      }),
    );
  }

  async findZoneForHostname(accountId: string, hostname: string): Promise<CloudflareZone | null> {
    const labels = hostname.split('.');
    for (let index = 0; index <= labels.length - 2; index++) {
      const zone = await this.findZone(accountId, labels.slice(index).join('.'));
      if (zone) {
        return zone;
      }
    }
    return null;
  }

  async listWorkerDomains(accountId: string): Promise<ReadonlyArray<CloudflareWorkerDomain>> {
    const result: Array<Record<string, unknown>> = [];
    const perPage = 100;
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      const response = await this.#requestEnvelope<ReadonlyArray<Record<string, unknown>>>(
        `/accounts/${encodeURIComponent(accountId)}/workers/domains?${query}`,
      );
      result.push(...response.result);
      const totalPages = response.resultInfo?.total_pages;
      if (
        (typeof totalPages === 'number' && page >= totalPages) ||
        (totalPages === undefined && response.result.length < perPage)
      ) {
        break;
      }
    }
    return result.map((entry) => ({
      hostname: requiredString(entry.hostname, 'Worker custom domain hostname'),
      id: requiredString(entry.id, 'Worker custom domain id'),
      service: requiredString(entry.service, 'Worker custom domain service'),
      ...(typeof entry.zone_name === 'string' ? { zoneName: entry.zone_name } : {}),
    }));
  }

  /**
   * Add missing Custom Domains without replacing the Worker's existing set or
   * authorizing takeover of another Worker origin or DNS record. Wrangler
   * enables destructive overrides automatically without a TTY, so the
   * installer deliberately owns this mutation through the API instead.
   */
  async publishWorkerCustomDomainsSafely(
    accountId: string,
    workerName: string,
    origins: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>,
  ): Promise<void> {
    const before = await this.listWorkerDomains(accountId);
    const pending = origins.filter((origin) => {
      const matches = before.filter((domain) => domain.hostname === origin.hostname);
      if (matches.length > 1 || matches.some((domain) => domain.service !== workerName)) {
        throw new PlatformWorkerCustomDomainsChangedError(
          `platform: Custom Domain ${JSON.stringify(origin.hostname)} changed concurrently before publication; refusing to replace its traffic state.`,
        );
      }
      return matches.length === 0;
    });
    if (pending.length === 0) {
      return;
    }
    try {
      await this.request(
        `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/domains/records`,
        {
          method: 'PUT',
          body: JSON.stringify({
            override_scope: false,
            override_existing_origin: false,
            override_existing_dns_record: false,
            origins: pending.map((origin) => ({
              hostname: origin.hostname,
              ...(origin.zoneId ? { zone_id: origin.zoneId } : {}),
              ...(origin.zoneName ? { zone_name: origin.zoneName } : {}),
              ...(origin.enabled === undefined ? {} : { enabled: origin.enabled }),
              ...(origin.previewsEnabled === undefined
                ? {}
                : { previews_enabled: origin.previewsEnabled }),
            })),
          }),
        },
      );
    } catch (error) {
      throw new PlatformWorkerCustomDomainsChangedError(
        `platform: Custom Domain publication for Worker ${JSON.stringify(workerName)} had an ambiguous outcome; retaining live domains for safe reconciliation.`,
        { cause: error },
      );
    }

    const inventory = await this.listWorkerDomains(accountId);
    const everyExpectedDomainIsUniqueAndOwned = origins.every(
      ({ hostname }) =>
        inventory.filter((domain) => domain.hostname === hostname && domain.service === workerName)
          .length === 1,
    );
    if (!everyExpectedDomainIsUniqueAndOwned) {
      throw new PlatformWorkerCustomDomainsChangedError(
        `platform: Worker ${JSON.stringify(workerName)} Custom Domains changed concurrently after publication; refusing to overwrite the newer traffic state.`,
      );
    }
  }

  async listWorkerRoutes(zoneId: string): Promise<ReadonlyArray<CloudflareWorkerRoute>> {
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/zones/${encodeURIComponent(zoneId)}/workers/routes`,
    );
    return result.map((entry) => ({
      id: requiredString(entry.id, 'Worker route id'),
      pattern: requiredString(entry.pattern, 'Worker route pattern'),
      script: typeof entry.script === 'string' ? entry.script : null,
    }));
  }

  async publishWorkerRoutesSafely(
    zoneId: string,
    workerName: string,
    patterns: ReadonlyArray<string>,
  ): Promise<void> {
    const before = await this.listWorkerRoutes(zoneId);
    const pending = patterns.filter((pattern) => {
      const matches = before.filter((route) => route.pattern === pattern);
      if (matches.length > 1 || matches.some((route) => route.script !== workerName)) {
        throw new PlatformWorkerRoutesChangedError(
          `platform: Worker route ${JSON.stringify(pattern)} changed concurrently before publication; refusing to replace its traffic state.`,
        );
      }
      return matches.length === 0;
    });
    for (const pattern of pending) {
      try {
        await this.request(`/zones/${encodeURIComponent(zoneId)}/workers/routes`, {
          body: JSON.stringify({ pattern, script: workerName }),
          method: 'POST',
        });
      } catch (error) {
        throw new PlatformWorkerRoutesChangedError(
          `platform: Worker route publication for ${JSON.stringify(pattern)} had an ambiguous outcome; retaining live routes for safe reconciliation.`,
          { cause: error },
        );
      }
    }
    const after = await this.listWorkerRoutes(zoneId);
    for (const pattern of patterns) {
      const matches = after.filter((route) => route.pattern === pattern);
      if (matches.length !== 1 || matches[0]!.script !== workerName) {
        throw new PlatformWorkerRoutesChangedError(
          `platform: Worker route ${JSON.stringify(pattern)} changed concurrently after publication; retaining live routes for safe reconciliation.`,
        );
      }
    }
  }

  async listWorkerServiceRoutes(
    accountId: string,
    workerName: string,
  ): Promise<ReadonlyArray<CloudflareWorkerServiceRoute>> {
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(workerName)}/environments/production/routes?show_zonename=true`,
    );
    return result.map((entry) => ({
      pattern: requiredString(entry.pattern, 'Worker service route pattern'),
      zoneName: requiredString(entry.zone_name, 'Worker service route zone name'),
    }));
  }

  async listDnsRecords(zoneId: string, name: string): Promise<ReadonlyArray<CloudflareDnsRecord>> {
    const query = new URLSearchParams({ name, per_page: '100' });
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`,
    );
    return result.map(parseDnsRecord);
  }

  /** Read deployed edge certificates; requesting a pack is not proof of issuance. */
  async hasActiveCertificateForHostname(zoneId: string, hostname: string): Promise<boolean> {
    const expected = hostname.toLowerCase().replace(/\.$/, '');
    const covers = (value: unknown): boolean => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
      }
      const cert = value as Record<string, unknown>;
      if (cert.status !== 'active' || !Array.isArray(cert.hosts)) {
        return false;
      }
      if (
        cert.expires_on !== undefined &&
        (typeof cert.expires_on !== 'string' ||
          !Number.isFinite(Date.parse(cert.expires_on)) ||
          Date.parse(cert.expires_on) <= Date.now())
      ) {
        return false;
      }
      return cert.hosts.some(
        (host) => typeof host === 'string' && host.toLowerCase().replace(/\.$/, '') === expected,
      );
    };
    for (const kind of ['ssl/certificate_packs', 'custom_certificates']) {
      for (let page = 1; page <= 200; page++) {
        const query = new URLSearchParams({ page: String(page), per_page: '50' });
        if (kind === 'ssl/certificate_packs') {
          query.set('deploy', 'production');
        }
        const { result, resultInfo } = await this.#requestEnvelope<
          ReadonlyArray<Record<string, unknown>>
        >(`/zones/${encodeURIComponent(zoneId)}/${kind}?${query}`);
        if (!Array.isArray(result)) {
          throw new Error('platform: Cloudflare returned an invalid certificate inventory.');
        }
        for (const entry of result) {
          const certificates =
            kind === 'ssl/certificate_packs'
              ? Array.isArray(entry.certificates)
                ? entry.certificates
                : []
              : [entry];
          if (certificates.some(covers)) {
            return true;
          }
        }
        if (
          result.length === 0 ||
          (resultInfo?.total_pages !== undefined
            ? page >= resultInfo.total_pages
            : result.length < 50)
        ) {
          break;
        }
        if (page === 200) {
          throw new Error('platform: Certificate inventory is too large to verify safely.');
        }
      }
    }
    return false;
  }

  async createDnsRecord(zoneId: string, name: string): Promise<CloudflareDnsRecord> {
    return parseDnsRecord(
      await this.request<Record<string, unknown>>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        {
          method: 'POST',
          body: JSON.stringify({ content: '100::', name, proxied: true, ttl: 1, type: 'AAAA' }),
        },
      ),
    );
  }

  async listKvNamespaces(
    accountId: string,
    title?: string,
  ): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const entries: Array<{ id?: unknown; title?: unknown }> = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: '100' });
      const result = await this.request<ReadonlyArray<{ id?: unknown; title?: unknown }>>(
        `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?${query}`,
      );
      entries.push(...result);
      if (result.length < 100) {
        break;
      }
    }
    const namespaces = entries.map((entry) => ({
      id: requiredString(entry.id, 'KV namespace id'),
      name: requiredString(entry.title, 'KV namespace title'),
    }));
    // The KV API lists all namespaces; it does not filter by a `title` parameter.
    // Filter only after pagination and validation, without hiding real duplicates.
    return title ? namespaces.filter((namespace) => namespace.name === title) : namespaces;
  }

  async createKvNamespace(accountId: string, title: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ id?: unknown; title?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`,
      { method: 'POST', body: JSON.stringify({ title }) },
    );
    return {
      id: requiredString(result.id, 'KV namespace id'),
      name: typeof result.title === 'string' ? result.title : title,
    };
  }

  async listR2Buckets(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const buckets: Array<{ creation_date?: unknown; name?: unknown }> = [];
    let startAfter = '';
    for (;;) {
      const query = new URLSearchParams({ direction: 'asc', order: 'name', per_page: '1000' });
      if (startAfter) {
        query.set('start_after', startAfter);
      }
      const result = await this.request<
        | { buckets?: ReadonlyArray<{ creation_date?: unknown; name?: unknown }> }
        | ReadonlyArray<{ creation_date?: unknown; name?: unknown }>
      >(`/accounts/${encodeURIComponent(accountId)}/r2/buckets?${query}`);
      const page = Array.isArray(result)
        ? result
        : 'buckets' in result
          ? (result.buckets ?? [])
          : [];
      buckets.push(...page);
      if (page.length < 1000) {
        break;
      }
      const next = requiredString(page.at(-1)?.name, 'R2 bucket name');
      if (next === startAfter) {
        throw new Error('platform: Cloudflare returned a non-advancing R2 bucket page.');
      }
      startAfter = next;
    }
    return buckets.map((entry) => {
      const name = requiredString(entry.name, 'R2 bucket name');
      return {
        fingerprint: requiredString(entry.creation_date, 'R2 bucket creation date'),
        id: name,
        name,
      };
    });
  }

  async createR2Bucket(accountId: string, name: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ creation_date?: unknown; name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets`,
      { method: 'POST', body: JSON.stringify({ name }) },
    );
    const resultName = typeof result.name === 'string' ? result.name : name;
    const fingerprint =
      typeof result.creation_date === 'string' && result.creation_date
        ? result.creation_date
        : (await this.listR2Buckets(accountId)).find((bucket) => bucket.name === resultName)
            ?.fingerprint;
    if (!fingerprint) {
      throw new Error(
        `platform: Cloudflare created R2 bucket ${JSON.stringify(resultName)} without returning a verifiable creation fingerprint.`,
      );
    }
    return {
      fingerprint,
      id: resultName,
      name: resultName,
    };
  }

  async listQueues(
    accountId: string,
    name: string,
  ): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const result = await this.request<ReadonlyArray<{ queue_id?: unknown; queue_name?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/queues?name=${encodeURIComponent(name)}&per_page=100`,
    );
    return result.map((entry) => ({
      id: requiredString(entry.queue_id, 'Queue id'),
      name: requiredString(entry.queue_name, 'Queue name'),
    }));
  }

  async createQueue(accountId: string, name: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ queue_id?: unknown; queue_name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/queues`,
      { method: 'POST', body: JSON.stringify({ queue_name: name }) },
    );
    return {
      id: requiredString(result.queue_id, 'Queue id'),
      name: typeof result.queue_name === 'string' ? result.queue_name : name,
    };
  }

  async listDispatchNamespaces(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const result = await this.request<
      ReadonlyArray<{ namespace_id?: unknown; namespace_name?: unknown }>
    >(`/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces`);
    return result.map((entry) => ({
      id: requiredString(entry.namespace_id, 'Dispatch namespace id'),
      name: requiredString(entry.namespace_name, 'Dispatch namespace name'),
    }));
  }

  async createDispatchNamespace(accountId: string, name: string): Promise<CloudflareNamedResource> {
    const result = await this.request<{ namespace_id?: unknown; namespace_name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces`,
      { method: 'POST', body: JSON.stringify({ name }) },
    );
    return {
      id: requiredString(result.namespace_id, 'Dispatch namespace id'),
      name: typeof result.namespace_name === 'string' ? result.namespace_name : name,
    };
  }

  async listHyperdriveConfigs(accountId: string): Promise<ReadonlyArray<CloudflareNamedResource>> {
    const entries: Array<{ id?: unknown; name?: unknown }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<ReadonlyArray<{ id?: unknown; name?: unknown }>>(
        `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs?page=${page}&per_page=50`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries.map((entry) => ({
      id: requiredString(entry.id, 'Hyperdrive id'),
      name: requiredString(entry.name, 'Hyperdrive name'),
    }));
  }

  async getHyperdriveConfig(accountId: string, id: string): Promise<CloudflareHyperdriveConfig> {
    const result = await this.request<Record<string, unknown>>(
      `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs/${encodeURIComponent(id)}`,
    );
    return parseHyperdriveConfig(result);
  }

  async createHyperdrive(
    accountId: string,
    name: string,
    connectionString: string,
  ): Promise<CloudflareNamedResource> {
    const parsed = parsePostgresConnectionString(connectionString);
    const result = await this.request<{ id?: unknown; name?: unknown }>(
      `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs`,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          caching: { disabled: true },
          origin: {
            database: parsed.database,
            host: parsed.host,
            password: parsed.password,
            port: parsed.port,
            scheme: 'postgresql',
            user: parsed.user,
          },
          ...(parsed.mtls ? { mtls: parsed.mtls } : {}),
        }),
      },
    );
    return {
      id: requiredString(result.id, 'Hyperdrive id'),
      name: typeof result.name === 'string' ? result.name : name,
    };
  }

  async listWorkerNames(accountId: string): Promise<ReadonlyArray<string>> {
    const result = await this.request<ReadonlyArray<{ id?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
    );
    return result.map((entry) => requiredString(entry.id, 'Worker name'));
  }

  async disableHyperdriveCaching(accountId: string, id: string): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ caching: { disabled: true } }),
      },
    );
  }

  async putKvValue(
    accountId: string,
    namespaceId: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`,
      { method: 'PUT', body: value, headers: { 'Content-Type': 'application/json' } },
    );
  }

  async getKvValue(accountId: string, namespaceId: string, key: string): Promise<string | null> {
    const response = await this.#fetcher(
      `${this.apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`,
      {
        headers: { Authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new PlatformCloudflareApiError(
        `Cloudflare API error reading the installation manifest (HTTP ${response.status}).`,
        response.status,
      );
    }
    return response.text();
  }

  async putR2Object(
    accountId: string,
    bucketName: string,
    key: string,
    value: string,
  ): Promise<void> {
    const response = await this.#fetcher(
      `${this.apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeR2ObjectKey(key)}`,
      {
        body: value,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
        },
        method: 'PUT',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new PlatformCloudflareApiError(
        `Cloudflare API error writing the R2 ownership marker (HTTP ${response.status}).`,
        response.status,
      );
    }
  }

  async getR2Object(accountId: string, bucketName: string, key: string): Promise<string | null> {
    const response = await this.#fetcher(
      `${this.apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeR2ObjectKey(key)}`,
      {
        headers: { Authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new PlatformCloudflareApiError(
        `Cloudflare API error reading the R2 ownership marker (HTTP ${response.status}).`,
        response.status,
      );
    }
    return response.text();
  }

  async deleteR2Object(accountId: string, bucketName: string, key: string): Promise<void> {
    try {
      await this.deleteR2Objects(accountId, bucketName, [key]);
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async getWorkerPlainTextBindings(
    accountId: string,
    workerName: string,
  ): Promise<Readonly<Record<string, string>>> {
    const settings = await this.request<{
      bindings?: ReadonlyArray<{ name?: unknown; text?: unknown; type?: unknown }>;
    }>(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
    );
    const bindings: Record<string, string> = {};
    for (const binding of settings.bindings ?? []) {
      if (
        binding.type === 'plain_text' &&
        typeof binding.name === 'string' &&
        typeof binding.text === 'string'
      ) {
        bindings[binding.name] = binding.text;
      }
    }
    return bindings;
  }

  /**
   * Where the last change to a Worker came from, for example `cf_cli`, `dash`
   * (Cloudflare dashboard) or `api` (Workers API). Null when the Worker does
   * not exist or Cloudflare does not report it.
   */
  async getWorkerLastDeployedFrom(accountId: string, workerName: string): Promise<string | null> {
    let service: { default_environment?: { script?: { last_deployed_from?: unknown } } } | null;
    try {
      service = await this.request(
        `/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(workerName)}`,
      );
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
    const source = service?.default_environment?.script?.last_deployed_from;
    return typeof source === 'string' && source !== '' ? source : null;
  }

  async deleteKvValue(accountId: string, namespaceId: string, key: string): Promise<void> {
    try {
      await this.request(
        `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async emptyR2Bucket(
    accountId: string,
    bucketName: string,
    preservedKeys: ReadonlySet<string> = new Set(),
    /** Runs before each page of deletes; throw to stop emptying the bucket. */
    beforeDelete?: () => Promise<void>,
  ): Promise<void> {
    let cursor = '';
    const observedCursors = new Set<string>();
    for (;;) {
      const query = new URLSearchParams({ per_page: '1000' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await this.#fetcher(
        `${this.apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects?${query}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.#token}`,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (response.status === 404) {
        return;
      }
      const envelope = (await response.json()) as CloudflareEnvelope<
        ReadonlyArray<{ key?: unknown }>
      >;
      if (!response.ok || envelope.success !== true || !Array.isArray(envelope.result)) {
        const details =
          envelope.errors
            ?.map((error) => error.message)
            .filter(Boolean)
            .join(', ') || `HTTP ${response.status}`;
        throw new PlatformCloudflareApiError(
          `Cloudflare API error listing R2 objects: ${details}`,
          response.status,
        );
      }
      const keys = envelope.result
        .map((object) => requiredString(object.key, 'R2 object key'))
        .filter((key) => !preservedKeys.has(key));
      if (keys.length > 0) {
        await beforeDelete?.();
      }
      for (let offset = 0; offset < keys.length; offset += 1000) {
        await this.deleteR2Objects(accountId, bucketName, keys.slice(offset, offset + 1000));
      }
      const nextCursor = envelope.result_info?.cursor ?? '';
      if (!nextCursor) {
        return;
      }
      if (observedCursors.has(nextCursor)) {
        throw new Error('platform: Cloudflare returned a repeated R2 object cursor.');
      }
      observedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  private async deleteR2Objects(
    accountId: string,
    bucketName: string,
    keys: ReadonlyArray<string>,
  ): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const deleted = await this.request<ReadonlyArray<{ key?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects`,
      { body: JSON.stringify(keys), method: 'DELETE' },
    );
    const deletedKeys = new Set(
      deleted.map((entry) => requiredString(entry.key, 'deleted R2 object key')),
    );
    const missing = keys.find((key) => !deletedKeys.has(key));
    if (missing !== undefined) {
      throw new Error('platform: Cloudflare did not confirm every requested R2 object deletion.');
    }
  }

  async deleteResource(
    accountId: string,
    resource: Readonly<{ id: string; kind: string; name: string }>,
    zoneId?: string,
  ): Promise<void> {
    const { kind } = resource;
    if (kind === 'ai-gateway' && this.#aiGatewayClient) {
      return this.#aiGatewayClient.deleteResource(accountId, resource, zoneId);
    }
    // Cloudflare addresses dispatch namespaces and Workers by name; every
    // other kind by id.
    const encoded = encodeURIComponent(
      kind === 'dispatch-namespace' || kind === 'worker' ? resource.name : resource.id,
    );
    const path = deletionPath(kind, encodeURIComponent(accountId), encoded, zoneId);
    if (!path) {
      throw new Error(`platform: Unsupported Cloudflare deletion kind ${kind}.`);
    }
    await this.#deleteIfPresent(path);
  }

  /**
   * DELETE one resource by the key Cloudflare addresses it with. Only
   * `forceDeleteWorker` sends `force`; otherwise Cloudflare refuses a
   * resource another Worker still uses. A 404 means it is already gone.
   */
  async #deleteIfPresent(path: string): Promise<void> {
    const response = await this.#fetcher(`${this.apiBaseUrl}${path}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${this.#token}` },
      method: 'DELETE',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) {
      return;
    }
    let envelope: CloudflareEnvelope<unknown> = {};
    try {
      envelope = (await response.json()) as CloudflareEnvelope<unknown>;
    } catch {
      // Judge an empty body by its status alone.
      envelope = { success: response.ok };
    }
    if (!response.ok || envelope.success !== true) {
      throw new PlatformCloudflareApiError(
        `Cloudflare API error: ${cloudflareErrorDetails(envelope, response.status)} (HTTP ${response.status}; DELETE ${path}).`,
        response.status,
        path,
      );
    }
  }

  async deleteWorkerRoute(zoneId: string, routeId: string): Promise<void> {
    await this.#deleteIfPresent(
      `/zones/${encodeURIComponent(zoneId)}/workers/routes/${encodeURIComponent(routeId)}`,
    );
  }

  async deleteWorkerDomain(accountId: string, domainId: string): Promise<void> {
    await this.#deleteIfPresent(
      `/accounts/${encodeURIComponent(accountId)}/workers/domains/${encodeURIComponent(domainId)}`,
    );
  }

  async listQueueConsumers(
    accountId: string,
    queueId: string,
  ): Promise<ReadonlyArray<CloudflareQueueConsumer>> {
    const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
      `/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queueId)}/consumers`,
    );
    return result.map((entry) => ({
      id: requiredString(entry.consumer_id, 'Queue consumer id'),
      // The API documents `script_name`; Wrangler still reads `script` and
      // `service`. A Worker consumer without a name would keep its Worker
      // and Queue from being deleted, so refuse it instead of skipping it.
      script:
        entry.type === 'http_pull'
          ? null
          : requiredString(
              entry.script_name ?? entry.script ?? entry.service,
              'Queue consumer Worker name',
            ),
    }));
  }

  async listWorkerDependents(
    accountId: string,
    workerName: string,
  ): Promise<CloudflareWorkerDependents> {
    const account = encodeURIComponent(accountId);
    const script = encodeURIComponent(workerName);
    type Reference = Readonly<{ script?: unknown; service?: unknown }>;
    const references = await this.request<{
      dispatch_outbounds?: ReadonlyArray<Reference>;
      durable_objects?: ReadonlyArray<Reference>;
      services?: { incoming?: ReadonlyArray<Reference>; pages_function?: unknown };
    }>(`/accounts/${account}/workers/scripts/${script}/references`);
    const tails = await this.request<ReadonlyArray<{ producer?: Reference }>>(
      `/accounts/${account}/workers/tails/by-consumer/${script}`,
    );
    const name = (reference: Reference | undefined) =>
      requiredString(reference?.script ?? reference?.service, 'Dependent Worker name');
    const workers = [
      ...(references.services?.incoming ?? []).map(name),
      // A Worker lists the Durable Object namespaces it implements itself.
      ...(references.durable_objects ?? []).map(name).filter((entry) => entry !== workerName),
      ...(references.dispatch_outbounds ?? []).map(name),
      ...tails.map((tail) => name(tail.producer)),
    ];
    return {
      pagesFunction: references.services?.pages_function === true,
      workers: [...new Set(workers)],
    };
  }

  /**
   * DELETE a Worker even though other Workers still bind to it. Cloudflare
   * leaves those bindings pointing at nothing, so callers first check that
   * every dependent is going away too.
   */
  async forceDeleteWorker(accountId: string, workerName: string): Promise<void> {
    await this.#deleteIfPresent(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}?force=true`,
    );
  }

  async deleteQueueConsumer(accountId: string, queueId: string, consumerId: string): Promise<void> {
    await this.#deleteIfPresent(
      `/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queueId)}/consumers/${encodeURIComponent(consumerId)}`,
    );
  }

  async listDispatchNamespaceScripts(
    accountId: string,
    namespace: string,
  ): Promise<ReadonlyArray<string>> {
    const result = await this.request<ReadonlyArray<{ id?: unknown }>>(
      `/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts`,
    );
    return result.map((entry) => requiredString(entry.id, 'Dispatch namespace script name'));
  }

  async deleteDispatchNamespaceScript(
    accountId: string,
    namespace: string,
    scriptName: string,
  ): Promise<void> {
    await this.#deleteIfPresent(
      `/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(scriptName)}`,
    );
  }

  /** Read one Access application or service token; null when it is gone. */
  async getAccessResource(
    accountId: string,
    kind: PlatformAccessResourceKind,
    id: string,
  ): Promise<CloudflareNamedResource | null> {
    try {
      const result = await this.request<{ id?: unknown; name?: unknown }>(
        accessResourcePath(accountId, kind, id),
      );
      return {
        id: requiredString(result.id, 'Access resource id'),
        name: requiredString(result.name, 'Access resource name'),
      };
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async deleteAccessResource(
    accountId: string,
    kind: PlatformAccessResourceKind,
    id: string,
  ): Promise<void> {
    await this.#deleteIfPresent(accessResourcePath(accountId, kind, id));
  }

  /** Email Routing rules in a zone, without the catch-all, which has its own endpoint. */
  async listEmailRoutingRules(zoneId: string): Promise<ReadonlyArray<CloudflareEmailRoutingRule>> {
    const entries: Array<Record<string, unknown>> = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: '50' });
      const result = await this.request<ReadonlyArray<Record<string, unknown>>>(
        `/zones/${encodeURIComponent(zoneId)}/email/routing/rules?${query}`,
      );
      entries.push(...result);
      if (result.length < 50) {
        break;
      }
    }
    return entries
      .filter(
        (entry) =>
          !(Array.isArray(entry.matchers) ? entry.matchers : []).some(
            (matcher: unknown) => (matcher as { type?: unknown } | null)?.type === 'all',
          ),
      )
      .map((entry) => ({
        // `tag` is the deprecated name of `id`.
        id: requiredString(entry.id ?? entry.tag, 'Email Routing rule id'),
        ...parseEmailRoutingTarget(entry),
      }));
  }

  async deleteEmailRoutingRule(zoneId: string, ruleId: string): Promise<void> {
    await this.#deleteIfPresent(
      `/zones/${encodeURIComponent(zoneId)}/email/routing/rules/${encodeURIComponent(ruleId)}`,
    );
  }

  /** The zone's Email Routing catch-all rule; null when the zone has none. */
  async getEmailRoutingCatchAll(zoneId: string): Promise<CloudflareEmailRoutingCatchAll | null> {
    try {
      return parseEmailRoutingTarget(
        await this.request<Record<string, unknown>>(
          `/zones/${encodeURIComponent(zoneId)}/email/routing/rules/catch_all`,
        ),
      );
    } catch (error) {
      if (error instanceof PlatformCloudflareApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Point the catch-all back at its disabled default, which drops mail. */
  async resetEmailRoutingCatchAll(zoneId: string): Promise<void> {
    await this.request(`/zones/${encodeURIComponent(zoneId)}/email/routing/rules/catch_all`, {
      method: 'PUT',
      body: JSON.stringify({
        matchers: [{ type: 'all' }],
        actions: [{ type: 'drop' }],
        enabled: false,
      }),
    });
  }
}

function accessResourcePath(
  accountId: string,
  kind: PlatformAccessResourceKind,
  id: string,
): string {
  return `/accounts/${encodeURIComponent(accountId)}/access/${kind === 'application' ? 'apps' : 'service_tokens'}/${encodeURIComponent(id)}`;
}

function parseEmailRoutingTarget(rule: Record<string, unknown>): CloudflareEmailRoutingCatchAll {
  const actions = Array.isArray(rule.actions) ? (rule.actions as Array<unknown>) : [];
  const action =
    actions.length === 1 ? (actions[0] as { type?: unknown; value?: unknown } | null) : null;
  const value = Array.isArray(action?.value) ? (action.value as Array<unknown>) : [];
  return {
    enabled: rule.enabled === true,
    workerName:
      action?.type === 'worker' && value.length === 1 && typeof value[0] === 'string'
        ? value[0]
        : null,
  };
}

function deletionPath(
  kind: string,
  account: string,
  encoded: string,
  zoneId: string | undefined,
): string | null {
  switch (kind) {
    case 'kv-namespace':
      return `/accounts/${account}/storage/kv/namespaces/${encoded}`;
    case 'dns-record':
      return zoneId ? `/zones/${encodeURIComponent(zoneId)}/dns_records/${encoded}` : null;
    case 'ai-gateway':
      return `/accounts/${account}/ai-gateway/gateways/${encoded}`;
    case 'r2-bucket':
      return `/accounts/${account}/r2/buckets/${encoded}`;
    case 'queue':
      return `/accounts/${account}/queues/${encoded}`;
    case 'dispatch-namespace':
      return `/accounts/${account}/workers/dispatch/namespaces/${encoded}`;
    case 'hyperdrive':
      return `/accounts/${account}/hyperdrive/configs/${encoded}`;
    case 'worker':
      return `/accounts/${account}/workers/scripts/${encoded}`;
    case 'zone':
      return `/zones/${encoded}`;
    default:
      return null;
  }
}

function cloudflarePrerequisiteHelp(
  envelope: CloudflareEnvelope<unknown>,
  status: number,
  path: string,
): string | undefined {
  if (status !== 403) {
    return;
  }
  const [, scope, accountId, service, resource] = path.split('/');
  if (scope !== 'accounts' || !accountId) {
    return;
  }
  if (service === 'r2' && envelope.errors?.some((error) => error.code === 10042)) {
    return (
      'Cloudflare R2 is not enabled for this account (code 10042). ' +
      `Complete R2 activation at ${formatUrl(`https://dash.cloudflare.com/${accountId}/r2/overview`)}, then retry the same command.`
    );
  }
  if (
    service === 'workers' &&
    resource === 'dispatch' &&
    envelope.errors?.some((error) => error.code === 10121)
  ) {
    return (
      'Cloudflare Workers for Platforms requires a paid subscription for this account (code 10121). ' +
      `Enable it at ${formatUrl(`https://dash.cloudflare.com/${accountId}/workers-for-platforms`)}. ` +
      'Enterprise customers can contact their account team. Then retry the same command.'
    );
  }
}

function cloudflareErrorDetails(envelope: CloudflareEnvelope<unknown>, status: number): string {
  return (
    envelope.errors
      ?.filter((error) => error.message)
      .map((error) =>
        error.code === undefined ? error.message : `${error.message} (code ${error.code})`,
      )
      .join(', ') || `HTTP ${status}`
  );
}

function encodeR2ObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * An AI Gateway creation time as ISO 8601 UTC. Cloudflare reports it without a
 * zone ("2026-10-05 18:29:14"), which JavaScript would read as local time.
 */
function withCreatedAt(value: unknown): { createdAt?: string } {
  if (typeof value !== 'string') {
    return {};
  }
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value);
  const time = Date.parse(zoneless ? `${value.replace(' ', 'T')}Z` : value);
  return Number.isNaN(time) ? {} : { createdAt: new Date(time).toISOString() };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`platform: ${label} is missing from the Cloudflare response.`);
  }
  return value;
}

function parseZone(value: Record<string, unknown>): CloudflareZone {
  return {
    id: requiredString(value.id, 'Zone id'),
    name: requiredString(value.name, 'Zone name'),
    nameServers: Array.isArray(value.name_servers)
      ? value.name_servers.filter((entry): entry is string => typeof entry === 'string')
      : [],
    status: requiredString(value.status, 'Zone status'),
  };
}

function parseDnsRecord(value: Record<string, unknown>): CloudflareDnsRecord {
  return {
    content: requiredString(value.content, 'DNS record content'),
    id: requiredString(value.id, 'DNS record id'),
    name: requiredString(value.name, 'DNS record name'),
    proxied: value.proxied === true,
    type: requiredString(value.type, 'DNS record type'),
  };
}

export function parsePostgresConnectionString(value: string): {
  database: string;
  host: string;
  mtls?: Readonly<{ sslmode: 'require' }>;
  password: string;
  port: number;
  user: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('platform: DATABASE_URL must be a PostgreSQL connection string.');
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
    throw new Error('platform: DATABASE_URL must use postgres:// or postgresql://.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.username || !url.password || !database) {
    throw new Error('platform: DATABASE_URL must include username, password, host, and database.');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('platform: DATABASE_URL has an invalid PostgreSQL port.');
  }
  const sslmode = url.searchParams.get('sslmode');
  let mtls: Readonly<{ sslmode: 'require' }> | undefined;
  if (sslmode) {
    if (sslmode !== 'require' && sslmode !== 'verify-ca' && sslmode !== 'verify-full') {
      throw new Error(
        'platform: Unsupported sslmode. Cloudflare Hyperdrive supports "require", "verify-ca", or "verify-full".',
      );
    }
    // Hyperdrive accepts its verify modes only with an uploaded CA certificate ID, which a
    // connection URL cannot carry. `require` is Hyperdrive's TLS mode that validates the server
    // certificate against public CAs; Void's own database connections still use the URL's mode.
    mtls = { sslmode: 'require' };
  }
  return {
    database,
    host: url.hostname,
    ...(mtls ? { mtls } : {}),
    password: decodeURIComponent(url.password),
    port,
    user: decodeURIComponent(url.username),
  };
}

export function hyperdriveOriginFromConnectionString(value: string): CloudflareHyperdriveOrigin {
  const parsed = parsePostgresConnectionString(value);
  return {
    database: parsed.database,
    host: parsed.host.toLowerCase(),
    port: parsed.port,
    scheme: 'postgresql',
    user: parsed.user,
  };
}

export function hyperdriveOriginConfigHash(origin: CloudflareHyperdriveOrigin): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        database: origin.database,
        host: origin.host.toLowerCase(),
        port: origin.port,
        scheme: 'postgresql',
        user: origin.user,
        ...(origin.accessClientId ? { accessClientId: origin.accessClientId } : {}),
      }),
    )
    .digest('hex');
}

export function hyperdriveOriginMatches(
  live: CloudflareHyperdriveOrigin,
  expected: CloudflareHyperdriveOrigin,
): boolean {
  return (
    live.database === expected.database &&
    live.host.toLowerCase() === expected.host.toLowerCase() &&
    live.port === expected.port &&
    live.accessClientId === expected.accessClientId &&
    live.scheme === expected.scheme &&
    (live.user === null || live.user === expected.user)
  );
}

function parseHyperdriveConfig(value: Record<string, unknown>): CloudflareHyperdriveConfig {
  const origin = value.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
    throw new Error('platform: Cloudflare Hyperdrive config has no origin metadata.');
  }
  const record = origin as Record<string, unknown>;
  const scheme = requiredString(record.scheme, 'Hyperdrive origin scheme').toLowerCase();
  if (scheme !== 'postgres' && scheme !== 'postgresql') {
    throw new Error(`platform: Unsupported Hyperdrive origin scheme ${JSON.stringify(scheme)}.`);
  }
  const accessClientId =
    typeof record.access_client_id === 'string' && record.access_client_id
      ? record.access_client_id
      : undefined;
  const port =
    accessClientId && record.port == null
      ? null
      : typeof record.port === 'number' || typeof record.port === 'string'
        ? Number(record.port)
        : NaN;
  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error('platform: Cloudflare Hyperdrive config has an invalid origin port.');
  }
  return {
    id: requiredString(value.id, 'Hyperdrive id'),
    name: requiredString(value.name, 'Hyperdrive name'),
    cachingDisabled:
      !!value.caching &&
      typeof value.caching === 'object' &&
      !Array.isArray(value.caching) &&
      (value.caching as Record<string, unknown>).disabled === true,
    origin: {
      ...(accessClientId ? { accessClientId } : {}),
      database: requiredString(record.database, 'Hyperdrive origin database'),
      host: requiredString(record.host, 'Hyperdrive origin host').toLowerCase(),
      port,
      scheme: 'postgresql',
      user: typeof record.user === 'string' && record.user ? record.user : null,
    },
  };
}
