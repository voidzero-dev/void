import type { R2LocationHint } from '@void/deploy-core';

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const CF_ZONE_API_BASE = 'https://api.cloudflare.com/client/v4/zones';

type CfApiResult<T> = Readonly<{
  success: boolean;
  errors: ReadonlyArray<{ code: number; message: string }>;
  result: T;
}>;

/**
 * Error thrown by `cfFetch` when the Cloudflare API returns a non-success
 * envelope. Exposes the HTTP `status` so callers can branch on the wire-level
 * code (e.g. treat 409 as a concurrent-create race) rather than relying on
 * fragile message matching. The `.message` format is preserved verbatim
 * (`Cloudflare API error: <joined messages>`) so existing string-based
 * detection keeps working as a defense-in-depth fallback.
 */
export class CloudflareApiError extends Error {
  readonly status: number;
  /** The envelope's numeric error codes (empty for hand-built errors). */
  readonly codes: ReadonlyArray<number>;
  constructor(message: string, status: number, codes: ReadonlyArray<number> = []) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.codes = codes;
  }
}

export class InvalidHyperdriveConnectionStringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHyperdriveConnectionStringError';
  }
}

export async function cfFetch<T>(url: string, apiToken: string, init?: RequestInit): Promise<T> {
  const deadline = new AbortController();
  const method = init?.method ?? 'GET';
  const pathname = new URL(url).pathname;
  const timer = setTimeout(() => {
    deadline.abort(
      new Error(
        `Cloudflare API request timed out after 60 seconds: ${method} ${pathname}.` +
          (method === 'GET' || method === 'HEAD'
            ? ''
            : ' The write may have succeeded; inspect its state before retrying.'),
      ),
    );
  }, 60_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  try {
    signal.throwIfAborted();
    const headers = new Headers(init?.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${apiToken}`);
    }
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(url, {
      ...init,
      signal,
      headers,
    });
    // Keep the same deadline through the body read: receiving headers does
    // not prove a stalled provider response has completed. Never replay writes.
    const json = await response.json<CfApiResult<T>>();
    if (!json.success) {
      const message = json.errors.map((error) => error.message).join(', ');
      throw new CloudflareApiError(
        `Cloudflare API error: ${message}`,
        response.status,
        json.errors.map((error) => error.code),
      );
    }
    return json.result;
  } catch (error) {
    if (deadline.signal.aborted && !init?.signal?.aborted) {
      throw deadline.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type D1DatabaseInfo = Readonly<{
  uuid: string;
  name: string;
}>;

export async function createD1Database(
  accountId: string,
  apiToken: string,
  name: string,
  options: { readReplication?: boolean } = {},
): Promise<D1DatabaseInfo> {
  return cfFetch<D1DatabaseInfo>(`${CF_API_BASE}/${accountId}/d1/database`, apiToken, {
    method: 'POST',
    body: JSON.stringify({
      name,
      ...(options.readReplication !== undefined && {
        read_replication: { mode: options.readReplication ? 'auto' : 'disabled' },
      }),
    }),
  });
}

export async function setD1ReadReplication(
  accountId: string,
  apiToken: string,
  databaseId: string,
  readReplication: boolean,
): Promise<void> {
  await cfFetch<D1DatabaseInfo>(`${CF_API_BASE}/${accountId}/d1/database/${databaseId}`, apiToken, {
    method: 'PUT',
    body: JSON.stringify({ read_replication: { mode: readReplication ? 'auto' : 'disabled' } }),
  });
}

export type KVNamespaceInfo = Readonly<{
  id: string;
  title: string;
}>;

export async function createKVNamespace(
  accountId: string,
  apiToken: string,
  title: string,
): Promise<KVNamespaceInfo> {
  return cfFetch<KVNamespaceInfo>(`${CF_API_BASE}/${accountId}/storage/kv/namespaces`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export type R2BucketInfo = Readonly<{
  name: string;
}>;

export async function createR2Bucket(
  accountId: string,
  apiToken: string,
  name: string,
  locationHint?: R2LocationHint,
): Promise<R2BucketInfo> {
  return cfFetch<R2BucketInfo>(`${CF_API_BASE}/${accountId}/r2/buckets`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ name, ...(locationHint ? { locationHint } : {}) }),
  });
}

export async function getD1DatabaseByName(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<D1DatabaseInfo> {
  const result = await cfFetch<ReadonlyArray<D1DatabaseInfo>>(
    `${CF_API_BASE}/${accountId}/d1/database?name=${encodeURIComponent(name)}`,
    apiToken,
  );
  if (result.length === 0) {
    throw new Error(`D1 database not found: ${name}`);
  }
  return result[0];
}

export async function getKVNamespaceByTitle(
  accountId: string,
  apiToken: string,
  title: string,
): Promise<KVNamespaceInfo> {
  const result = await cfFetch<ReadonlyArray<KVNamespaceInfo>>(
    `${CF_API_BASE}/${accountId}/storage/kv/namespaces?title=${encodeURIComponent(title)}`,
    apiToken,
  );
  if (result.length === 0) {
    throw new Error(`KV namespace not found: ${title}`);
  }
  return result[0];
}

export async function getQueueByName(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<QueueInfo> {
  const result = await cfFetch<ReadonlyArray<QueueInfo>>(
    `${CF_API_BASE}/${accountId}/queues?name=${encodeURIComponent(name)}`,
    apiToken,
  );
  if (result.length === 0) {
    throw new Error(`Queue not found: ${name}`);
  }
  return result[0];
}

export async function deleteD1Database(
  accountId: string,
  apiToken: string,
  databaseId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/d1/database/${databaseId}`, apiToken, {
    method: 'DELETE',
  });
}

export async function deleteKVNamespace(
  accountId: string,
  apiToken: string,
  namespaceId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/storage/kv/namespaces/${namespaceId}`, apiToken, {
    method: 'DELETE',
  });
}

export async function deleteR2Bucket(
  accountId: string,
  apiToken: string,
  bucketName: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/r2/buckets/${bucketName}`, apiToken, {
    method: 'DELETE',
  });
}

// --- Queues ---

export type QueueInfo = Readonly<{
  queue_id: string;
  queue_name: string;
}>;

export async function createQueue(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<QueueInfo> {
  return cfFetch<QueueInfo>(`${CF_API_BASE}/${accountId}/queues`, apiToken, {
    method: 'POST',
    body: JSON.stringify({ queue_name: name }),
  });
}

export type QueueConsumerSettings = Readonly<{
  batch_size?: number;
  max_wait_time_ms?: number;
  max_concurrency?: number;
  max_retries?: number;
  retry_delay?: number;
}>;

export type QueueConsumerInfo = Readonly<{
  consumer_id: string;
  // CF Queues API asymmetry: POST/PUT bodies use `script_name`, but
  // GET /queues/{id}/consumers returns the subscribed worker under
  // `script`. Reading `script_name` would return `undefined` for every
  // consumer and misreport a same-script re-deploy as an ownership conflict.
  script: string;
  type: string;
  settings: QueueConsumerSettings;
}>;

/** Read this script's exact consumer state without touching another owner. */
export async function snapshotQueueConsumer(
  accountId: string,
  apiToken: string,
  queueId: string,
  scriptName: string,
): Promise<QueueConsumerInfo | null> {
  const consumers = await cfFetch<ReadonlyArray<QueueConsumerInfo>>(
    `${CF_API_BASE}/${accountId}/queues/${queueId}/consumers`,
    apiToken,
  );
  return consumers.find((consumer) => consumer.script === scriptName) ?? null;
}

/** Remove only this script's consumer, leaving a conflicting owner untouched. */
export async function removeQueueConsumer(
  accountId: string,
  apiToken: string,
  queueId: string,
  scriptName: string,
): Promise<void> {
  const existing = await snapshotQueueConsumer(accountId, apiToken, queueId, scriptName);
  if (!existing) {
    return;
  }
  await cfFetch(
    `${CF_API_BASE}/${accountId}/queues/${queueId}/consumers/${existing.consumer_id}`,
    apiToken,
    { method: 'DELETE' },
  );
}

/** Restore a consumer snapshot exactly, or restore its prior absence. */
export async function restoreQueueConsumer(
  accountId: string,
  apiToken: string,
  queueId: string,
  scriptName: string,
  snapshot: QueueConsumerInfo | null,
): Promise<void> {
  if (!snapshot) {
    await removeQueueConsumer(accountId, apiToken, queueId, scriptName);
    return;
  }
  const consumersUrl = `${CF_API_BASE}/${accountId}/queues/${queueId}/consumers`;
  const current = await snapshotQueueConsumer(accountId, apiToken, queueId, scriptName);
  const body = JSON.stringify({
    script_name: snapshot.script,
    type: snapshot.type,
    settings: snapshot.settings,
  });
  if (current) {
    await cfFetch(`${consumersUrl}/${current.consumer_id}`, apiToken, { method: 'PUT', body });
  } else {
    await cfFetch(consumersUrl, apiToken, { method: 'POST', body });
  }
}

/**
 * Result of a queue consumer upsert. `created` = a new consumer was
 * registered. `updated` = our script already owned the consumer (settings
 * may have been PUT). `conflict` = a different script owns the consumer;
 * caller must decide whether to fail or surface a warning. Queue names are
 * derived from projectId so the conflict path is only reachable when a
 * rogue consumer was registered out-of-band.
 */
export type AddQueueConsumerResult =
  | { status: 'created' }
  | { status: 'updated' }
  | { status: 'conflict'; ownerScript: string };

/**
 * Create or update a queue consumer. POST creates on first deploy; on
 * subsequent deploys the POST fails with "already exists" and we PUT
 * to update settings instead.
 */
export async function addQueueConsumer(
  accountId: string,
  apiToken: string,
  queueId: string,
  scriptName: string,
  settings?: QueueConsumerSettings,
): Promise<AddQueueConsumerResult> {
  const consumersUrl = `${CF_API_BASE}/${accountId}/queues/${queueId}/consumers`;
  const consumerBody = {
    script_name: scriptName,
    type: 'worker',
    ...(settings && { settings }),
  };

  try {
    await cfFetch(consumersUrl, apiToken, {
      method: 'POST',
      body: JSON.stringify(consumerBody),
    });
    return { status: 'created' };
  } catch (err) {
    if (
      !(err instanceof Error) ||
      (!err.message.toLowerCase().includes('already exists') &&
        !err.message.toLowerCase().includes('already has a consumer'))
    ) {
      throw err;
    }
  }

  // Consumer exists — find ours and update settings
  const consumers = await cfFetch<ReadonlyArray<QueueConsumerInfo>>(consumersUrl, apiToken);
  const existingConsumer = consumers.find((consumer) => consumer.script === scriptName);

  if (!existingConsumer) {
    // A different script owns this consumer. Surface the owner so the
    // caller can emit a deploy warning; do not throw — the deploy should
    // still complete so other queues in the same manifest can succeed.
    const ownerScript = consumers[0]?.script ?? 'unknown';
    return { status: 'conflict', ownerScript };
  }

  if (settings) {
    await cfFetch(`${consumersUrl}/${existingConsumer.consumer_id}`, apiToken, {
      method: 'PUT',
      body: JSON.stringify(consumerBody),
    });
  }
  return { status: 'updated' };
}

export async function deleteQueue(
  accountId: string,
  apiToken: string,
  queueId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/queues/${queueId}`, apiToken, {
    method: 'DELETE',
  });
}

type DispatchWorkerBinding = Readonly<{
  type: string;
  name: string;
  text?: string;
}>;

export type ProxyTokenLookup =
  | { kind: 'found'; token: string }
  | { kind: 'missing' }
  | { kind: 'error'; error: Error };

/**
 * Read the `__VOID_PROXY_TOKEN` plain-text binding that was baked into a
 * user worker at deploy time. Used on rollback/backfill so we hand
 * dispatch the EXACT token the target worker expects, rather than
 * re-deriving from the current `JWT_SECRET` — which would 401 if the
 * secret had rotated since that deployment was live.
 *
 * Returns a typed result so callers can distinguish:
 *   - `found`: use the baked token as-is.
 *   - `missing`: bindings list returned but no `__VOID_PROXY_TOKEN` —
 *     a legacy worker. Callers may fall back to re-derivation with a
 *     visible warning.
 *   - `error`: CF API failure (rate limit, transport, auth, 5xx).
 *     Callers MUST NOT fall back silently — a transient error must
 *     not end up writing a mismatched token that 401s after a
 *     `JWT_SECRET` rotation.
 */
export async function getDispatchWorkerProxyToken(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
): Promise<ProxyTokenLookup> {
  const url = `${CF_API_BASE}/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}/bindings`;
  let bindings: ReadonlyArray<DispatchWorkerBinding>;
  try {
    bindings = await cfFetch<ReadonlyArray<DispatchWorkerBinding>>(url, apiToken);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { kind: 'error', error };
  }
  const token = bindings.find(
    (binding) => binding.type === 'plain_text' && binding.name === '__VOID_PROXY_TOKEN',
  )?.text;
  if (!token) {
    return { kind: 'missing' };
  }
  return { kind: 'found', token };
}

// --- Custom Hostnames (CF for SaaS) ---

export type CustomHostnameInfo = Readonly<{
  id: string;
  hostname: string;
  status: string;
  created_at?: string;
  ssl: Readonly<{
    status: string;
    method?: 'http' | 'txt' | 'email';
    type?: string;
    txt_name?: string;
    txt_value?: string;
    validation_records?: ReadonlyArray<
      Readonly<{
        txt_name?: string;
        txt_value?: string;
        status?: string;
      }>
    >;
  }>;
  ownership_verification?: Readonly<{
    type: 'txt';
    name: string;
    value: string;
  }>;
  // CF's HTTP-based ownership challenge. Returned alongside (or instead of)
  // the TXT `ownership_verification` depending on the hostname's state. The
  // activation gate must treat the presence of EITHER as "ownership not yet
  // settled" — keying on the TXT field alone would let an HTTP-satisfiable
  // (wildcard-routable) ownership slip through.
  ownership_verification_http?: Readonly<{
    http_url: string;
    http_body: string;
  }>;
  custom_metadata?: Readonly<Record<string, string>>;
  verification_errors?: ReadonlyArray<string>;
}>;

// Do NOT add `custom_metadata` here — it's a paid Enterprise SSL-for-SaaS
// add-on that our CF account is not provisioned for. Sending the field
// makes CF reject every create with "No custom metadata access has been
// allocated for this zone or account", breaking `void domain add`.
// Forensic attribution is already persisted server-side in the `domains`
// table (project_id, user_id, created_at) keyed by cf_hostname_id.
export async function createCustomHostname(
  zoneId: string,
  apiToken: string,
  hostname: string,
): Promise<CustomHostnameInfo> {
  return cfFetch<CustomHostnameInfo>(`${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames`, apiToken, {
    method: 'POST',
    body: JSON.stringify({
      hostname,
      ssl: { method: 'http', type: 'dv' },
    }),
  });
}

export async function getCustomHostnameByHostname(
  zoneId: string,
  apiToken: string,
  hostname: string,
): Promise<CustomHostnameInfo | null> {
  const params = new URLSearchParams({
    hostname,
    per_page: '50',
  });
  const matches = await cfFetch<ReadonlyArray<CustomHostnameInfo>>(
    `${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames?${params}`,
    apiToken,
  );
  return matches.find((match) => match.hostname === hostname) ?? null;
}

export async function getCustomHostname(
  zoneId: string,
  apiToken: string,
  hostnameId: string,
): Promise<CustomHostnameInfo> {
  return cfFetch<CustomHostnameInfo>(
    `${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames/${hostnameId}`,
    apiToken,
  );
}

// Re-send the SSL block via PATCH to re-trigger HTTP DCV. Void's flow is
// add-domain-first: `void domain add` creates the custom hostname with
// `ssl.method:'http'` BEFORE the user points the CNAME at `cname.void.app`.
// Per CF's Create Custom Hostname API docs, "If `http` is used and the domain
// is not already pointing to the Managed CNAME host, the PATCH method must be
// used once it is" to complete validation. Our cron/status path otherwise only
// GETs the hostname, so an add-first domain that the user later fixes can stay
// pending forever (or get CF-deleted after 7 days). A no-change PATCH re-sends
// the same `ssl` block, which both re-triggers HTTP DCV and resets CF's decaying
// validation-retry backoff (per CF's realtime-validation behavior).
export async function patchCustomHostname(
  zoneId: string,
  apiToken: string,
  hostnameId: string,
): Promise<CustomHostnameInfo> {
  return cfFetch<CustomHostnameInfo>(
    `${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames/${hostnameId}`,
    apiToken,
    {
      method: 'PATCH',
      body: JSON.stringify({ ssl: { method: 'http', type: 'dv' } }),
    },
  );
}

export async function deleteCustomHostname(
  zoneId: string,
  apiToken: string,
  hostnameId: string,
): Promise<void> {
  await cfFetch(`${CF_ZONE_API_BASE}/${zoneId}/custom_hostnames/${hostnameId}`, apiToken, {
    method: 'DELETE',
  });
}

// --- Hyperdrive ---

export type HyperdriveInfo = Readonly<{
  id: string;
  name: string;
}>;

type HyperdriveOrigin = Readonly<{
  database: string;
  host: string;
  password: string;
  port?: number;
  scheme: 'postgres' | 'postgresql' | 'mysql';
  user: string;
}>;

type HyperdriveConfigPayload = Readonly<{
  name?: string;
  origin: HyperdriveOrigin;
}>;

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InvalidHyperdriveConnectionStringError(
      'Invalid Hyperdrive connection string encoding.',
    );
  }
}

export function parseHyperdriveConnectionString(connectionString: string): HyperdriveConfigPayload {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new InvalidHyperdriveConnectionStringError('Invalid Hyperdrive connection string.');
  }

  const scheme = url.protocol.slice(0, -1);
  if (scheme !== 'postgres' && scheme !== 'postgresql' && scheme !== 'mysql') {
    throw new InvalidHyperdriveConnectionStringError(
      'Connection string must start with "postgres://", "postgresql://", or "mysql://".',
    );
  }
  if (!url.hostname) {
    throw new InvalidHyperdriveConnectionStringError(
      'Hyperdrive connection string must include a host.',
    );
  }
  if (!url.username) {
    throw new InvalidHyperdriveConnectionStringError(
      'Hyperdrive connection string must include a user.',
    );
  }
  if (!url.password) {
    throw new InvalidHyperdriveConnectionStringError(
      'Hyperdrive connection string must include a password.',
    );
  }

  const database = decodeUrlPart(url.pathname.replace(/^\/+/, ''));
  if (!database) {
    throw new InvalidHyperdriveConnectionStringError(
      'Hyperdrive connection string must include a database name.',
    );
  }

  const port = url.port ? Number(url.port) : scheme === 'mysql' ? 3306 : 5432;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new InvalidHyperdriveConnectionStringError(
      'Hyperdrive connection string port is invalid.',
    );
  }

  const sslmode = url.searchParams.get('sslmode');
  if (sslmode && sslmode !== 'require' && sslmode !== 'verify-ca' && sslmode !== 'verify-full') {
    throw new InvalidHyperdriveConnectionStringError(
      'Unsupported sslmode. Cloudflare Hyperdrive supports "require", "verify-ca", or "verify-full".',
    );
  }
  // No `mtls` is sent. A new Hyperdrive gets Cloudflare's default `require` mode, and a PUT
  // keeps the TLS settings already on the Hyperdrive. The verify modes need a CA certificate
  // uploaded to Cloudflare, which a URL cannot carry; `sslrootcert` names a file on the client.

  return {
    origin: {
      database,
      host: url.hostname,
      password: decodeUrlPart(url.password),
      port,
      scheme,
      user: decodeUrlPart(url.username),
    },
  };
}

export async function createHyperdrive(
  accountId: string,
  apiToken: string,
  name: string,
  connectionString: string,
): Promise<HyperdriveInfo> {
  const payload = {
    name,
    caching: { disabled: true },
    ...parseHyperdriveConnectionString(connectionString),
  };
  return cfFetch<HyperdriveInfo>(`${CF_API_BASE}/${accountId}/hyperdrive/configs`, apiToken, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateHyperdrive(
  accountId: string,
  apiToken: string,
  hyperdriveId: string,
  connectionString: string,
  name?: string,
): Promise<HyperdriveInfo> {
  const payload = {
    ...(name === undefined ? {} : { name }),
    caching: { disabled: true },
    ...parseHyperdriveConnectionString(connectionString),
  };
  return cfFetch<HyperdriveInfo>(
    `${CF_API_BASE}/${accountId}/hyperdrive/configs/${hyperdriveId}`,
    apiToken,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  );
}

/**
 * Hyperdrive never invalidates cached reads when the app writes, so project
 * databases run uncached. A config may predate this setting, so deploys
 * converge it. PATCH changes caching only and needs no origin password.
 */
export async function ensureHyperdriveCachingDisabled(
  accountId: string,
  apiToken: string,
  hyperdriveId: string,
): Promise<void> {
  const url = `${CF_API_BASE}/${accountId}/hyperdrive/configs/${hyperdriveId}`;
  const config = await cfFetch<Readonly<{ caching?: Readonly<{ disabled?: boolean }> }>>(
    url,
    apiToken,
  );
  if (config.caching?.disabled === true) {
    return;
  }
  await cfFetch(url, apiToken, {
    method: 'PATCH',
    body: JSON.stringify({ caching: { disabled: true } }),
  });
}

export async function deleteHyperdrive(
  accountId: string,
  apiToken: string,
  hyperdriveId: string,
): Promise<void> {
  await cfFetch(`${CF_API_BASE}/${accountId}/hyperdrive/configs/${hyperdriveId}`, apiToken, {
    method: 'DELETE',
  });
}

export async function getHyperdriveByName(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<HyperdriveInfo> {
  const result = await cfFetch<ReadonlyArray<HyperdriveInfo>>(
    `${CF_API_BASE}/${accountId}/hyperdrive/configs`,
    apiToken,
  );
  const match = result.find((hyperdrive) => hyperdrive.name === name);
  if (!match) {
    throw new Error(`Hyperdrive config not found: ${name}`);
  }
  return match;
}

// --- Cache Purge ---

export async function purgeZoneCache(
  zoneId: string,
  apiToken: string,
  files: ReadonlyArray<string>,
): Promise<void> {
  // CF API allows max 100 URLs per purge request (Free/Pro/Business)
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    await cfFetch(`${CF_ZONE_API_BASE}/${zoneId}/purge_cache`, apiToken, {
      method: 'POST',
      body: JSON.stringify({ files: batch }),
    });
  }
}
