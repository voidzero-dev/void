/** Customer Cloudflare API client for email routing and sending. */

import { CloudflareApiError } from '../provisioning/cloudflare-api.ts';
import {
  RELAY_ACCOUNT_BINDING,
  RELAY_GATEWAY_ORIGIN_BINDING,
  RELAY_INGRESS_BINDING,
  RELAY_SECRET_BINDING,
  RELAY_ZONE_BINDING,
} from './relay-worker.ts';

export const CF_CUSTOMER_API_BASE = 'https://api.cloudflare.com/client/v4';

type CfCustomerResult<T> = Readonly<{
  success: boolean;
  errors: ReadonlyArray<{ code: number; message: string }>;
  result: T;
}>;

/**
 * cfFetch with a customer credential: same envelope handling and typed error,
 * but FormData bodies keep their multipart Content-Type.
 */
export async function cfCustomerFetch<T>(
  url: string,
  credential: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${credential}`,
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  const json = (await response.json()) as CfCustomerResult<T>;
  if (!json.success) {
    const message = json.errors.map((error) => error.message).join(', ');
    throw new CloudflareApiError(
      `Cloudflare API error: ${message}`,
      response.status,
      json.errors.map((error) => error.code),
    );
  }
  return json.result;
}

export type CfTokenVerification = Readonly<{
  id: string;
  status: string;
  expires_on?: string | null;
}>;

export type CfCustomerZone = Readonly<{
  id: string;
  name: string;
  account: Readonly<{ id: string }>;
}>;

export type RelayScriptUpload = Readonly<{
  /** Module-syntax worker source (RELAY_SOURCE). */
  source: string;
  compatibilityDate: string;
  gatewayOrigin: string;
  accountId: string;
  zoneId: string;
  ingressName: string;
}>;

export type CfCatchAllRule = Readonly<{
  enabled: boolean;
  /** The worker name a 'worker' action points at; null for any other action shape. */
  workerName: string | null;
}>;
export type CfEmailRoutingRule = Readonly<{
  enabled: boolean;
  name: string | null;
  addresses: ReadonlyArray<string>;
  id: string | null;
  workerName: string | null;
  /** Only a single literal `to` matcher and a single Worker action can be owned. */
  literalWorker: boolean;
}>;

function parseRoutingRule(value: unknown): CfEmailRoutingRule {
  const rule = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const matchers = Array.isArray(rule.matchers) ? rule.matchers : [];
  const actions = Array.isArray(rule.actions) ? rule.actions : [];
  const addresses = matchers.flatMap((matcher: unknown) => {
    if (!matcher || typeof matcher !== 'object') {
      return [];
    }
    const m = matcher as Record<string, unknown>;
    return m.type === 'literal' && m.field === 'to' && typeof m.value === 'string'
      ? [m.value.toLowerCase()]
      : [];
  });
  const action =
    actions.length === 1 && actions[0] && typeof actions[0] === 'object'
      ? (actions[0] as Record<string, unknown>)
      : null;
  const workerName =
    action?.type === 'worker' &&
    Array.isArray(action.value) &&
    action.value.length === 1 &&
    typeof action.value[0] === 'string'
      ? action.value[0]
      : null;
  return {
    id: typeof rule.id === 'string' && rule.id ? rule.id : null,
    enabled: rule.enabled === true,
    name: typeof rule.name === 'string' ? rule.name : null,
    addresses,
    workerName,
    literalWorker: matchers.length === 1 && addresses.length === 1 && workerName !== null,
  };
}

/** One entry of the sending-subdomain list; name + enabled are required on the wire. */
export type CfSendingSubdomain = Readonly<{
  name: string;
  enabled: boolean;
}>;

/** A DNS conflict that Email Sending onboarding reports for a name, from the read-only preview. */
export type CfSendingIssue = Readonly<{
  code: string;
  /** The DNS name of the conflicting record, when Cloudflare reports one. */
  name: string | null;
}>;

export type CfCustomerClient = Readonly<{
  /** Verify a user or account token against the zone's authoritative account. */
  verifyToken: (accountId: string) => Promise<CfTokenVerification>;
  /** GET /zones?name= — exact-name match, or null when the credential can't see it. */
  findZone: (name: string) => Promise<CfCustomerZone | null>;
  /**
   * POST /zones/{z}/email/routing/dns. Empty body enables the apex;
   * { name } enables a subdomain (terraform-provider-cloudflare#5890's
   * Support quote; only the GET's `subdomain` query param is deprecated).
   */
  enableRouting: (zoneId: string, name?: string) => Promise<void>;
  /** POST /zones/{z}/email/sending/subdomains — the call wrangler's `email sending enable` makes. */
  onboardSending: (zoneId: string, name: string) => Promise<void>;
  /**
   * GET /zones/{z}/email/sending/subdomains — the onboard_sending
   * idempotency read-back for setup re-runs. Parsed down to name +
   * enabled (both required on the wire); malformed entries are dropped.
   */
  listSendingSubdomains: (zoneId: string) => Promise<ReadonlyArray<CfSendingSubdomain>>;
  /**
   * POST /zones/{z}/email/sending/subdomains/preview — a read-only dry run of onboarding.
   * Returns every issue Cloudflare reports, including records that are only missing.
   */
  previewSending: (zoneId: string, name: string) => Promise<ReadonlyArray<CfSendingIssue>>;
  /** Raw script GET — true when the name is taken in this account, false on 404. */
  relayScriptExists: (accountId: string, scriptName: string) => Promise<boolean>;
  /**
   * PUT /accounts/{a}/workers/scripts/{name} as multipart FormData:
   * a metadata part (main_module + compatibility_date + the plain-text
   * vars) and one module part — the WfP upload shape from routes/deploy.ts
   * minus the dispatch namespace.
   */
  putRelayScript: (
    accountId: string,
    scriptName: string,
    upload: RelayScriptUpload,
  ) => Promise<void>;
  /** PUT .../secrets — the non-namespace variant of putWorkerSecret (project-secrets.ts). */
  putRelaySecret: (accountId: string, scriptName: string, secret: string) => Promise<void>;
  /** Public probe routing for the deployed ingress Worker. */
  getWorkersSubdomain: (accountId: string) => Promise<string>;
  getScriptSubdomainEnabled: (accountId: string, scriptName: string) => Promise<boolean>;
  enableScriptSubdomain: (accountId: string, scriptName: string) => Promise<void>;
  /** PUT catch-all pointing the zone at the relay. `value` is a one-entry array, one action only. */
  setCatchAll: (zoneId: string, relayWorkerName: string) => Promise<void>;
  /**
   * GET catch-all — the ownership read before any write. The catch-all is
   * zone-scoped with no domain parameter, so one PUT can hijack another
   * domain's (or another tool's) inbound; callers must read first and only
   * write what they own. 404 → null.
   */
  getCatchAll: (zoneId: string) => Promise<CfCatchAllRule | null>;
  /** Enabled explicit address rules outrank a zone catch-all. */
  listRoutingRules: (zoneId: string) => Promise<ReadonlyArray<CfEmailRoutingRule>>;
  getRoutingRule: (zoneId: string, ruleId: string) => Promise<CfEmailRoutingRule | null>;
  putLiteralRule: (
    zoneId: string,
    ruleId: string | null,
    input: {
      name: string;
      address: string;
      workerName: string;
    },
  ) => Promise<CfEmailRoutingRule>;
  deleteRoutingRule: (zoneId: string, ruleId: string) => Promise<void>;
  enableSubaddressing: (zoneId: string) => Promise<void>;
  /** PUT catch-all with wrangler's reset shape: one drop action, disabled. */
  resetCatchAll: (zoneId: string) => Promise<void>;
  /**
   * GET /zones/{z}/email/routing — raw result. The subdomain-readiness
   * fields are probe-pinned, so callers parse defensively.
   */
  getRoutingSettings: (zoneId: string) => Promise<unknown>;
  /** DELETE the relay script. 404 is success — the customer may have deleted it themselves. */
  deleteRelayScript: (accountId: string, scriptName: string) => Promise<void>;
}>;

export function createCfCustomerClient(credential: string): CfCustomerClient {
  const call = <T>(path: string, init?: RequestInit): Promise<T> =>
    cfCustomerFetch<T>(`${CF_CUSTOMER_API_BASE}${path}`, credential, init);

  return {
    verifyToken: async (accountId) => {
      try {
        return await call<CfTokenVerification>('/user/tokens/verify');
      } catch (error) {
        if (
          !(error instanceof CloudflareApiError) ||
          (error.status !== 401 && error.status !== 403)
        ) {
          throw error;
        }
        return call<CfTokenVerification>(
          `/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
        );
      }
    },

    findZone: async (name) => {
      const zones = await call<ReadonlyArray<CfCustomerZone>>(
        `/zones?name=${encodeURIComponent(name)}`,
      );
      return zones.find((zone) => zone.name.toLowerCase() === name.toLowerCase()) ?? null;
    },

    enableRouting: async (zoneId, name) => {
      await call(`/zones/${zoneId}/email/routing/dns`, {
        method: 'POST',
        ...(name === undefined ? {} : { body: JSON.stringify({ name }) }),
      });
    },

    onboardSending: async (zoneId, name) => {
      await call(`/zones/${zoneId}/email/sending/subdomains`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    },

    listSendingSubdomains: async (zoneId) => {
      // The list paginates (CF v4 default page size 20): an onboarded
      // domain past the first page must still confirm the read-back. The
      // envelope's result_info is discarded by cfCustomerFetch, so a short
      // page is the last page; the page cap is defensive, never hit in
      // practice.
      const parsed: Array<CfSendingSubdomain> = [];
      for (let page = 1; page <= 20; page++) {
        const rows = await call<unknown>(
          `/zones/${zoneId}/email/sending/subdomains?page=${page}&per_page=50`,
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          break;
        }
        for (const row of rows) {
          if (
            row &&
            typeof row === 'object' &&
            typeof (row as { name?: unknown }).name === 'string'
          ) {
            parsed.push({
              name: (row as { name: string }).name,
              enabled: (row as { enabled?: unknown }).enabled === true,
            });
          }
        }
        if (rows.length < 50) {
          break;
        }
      }
      return parsed;
    },

    previewSending: async (zoneId, name) => {
      const preview = await call<{ errors?: unknown }>(
        `/zones/${zoneId}/email/sending/subdomains/preview`,
        { method: 'POST', body: JSON.stringify({ name }) },
      );
      const issues: Array<CfSendingIssue> = [];
      for (const row of Array.isArray(preview?.errors) ? preview.errors : []) {
        if (!row || typeof row !== 'object' || typeof row.code !== 'string') {
          continue;
        }
        const existing = (row as { existing?: { name?: unknown } }).existing;
        const multiple = (row as { multiple?: Array<{ name?: unknown }> }).multiple;
        const recordName = existing?.name ?? (Array.isArray(multiple) ? multiple[0]?.name : null);
        issues.push({
          code: row.code,
          name: typeof recordName === 'string' ? recordName : null,
        });
      }
      return issues;
    },

    relayScriptExists: async (accountId, scriptName) => {
      const response = await fetch(
        `${CF_CUSTOMER_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}`,
        { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (response.status === 404) {
        return false;
      }
      if (!response.ok) {
        throw new CloudflareApiError(
          `Cloudflare API error: script lookup failed with HTTP ${response.status}`,
          response.status,
        );
      }
      // The answer is the worker's source — the customer's code. Only
      // existence matters; never read it into memory.
      await response.body?.cancel();
      return true;
    },

    putRelayScript: async (accountId, scriptName, upload) => {
      const metadata = {
        main_module: 'index.js',
        compatibility_date: upload.compatibilityDate,
        bindings: [
          {
            type: 'plain_text',
            name: RELAY_GATEWAY_ORIGIN_BINDING,
            text: upload.gatewayOrigin,
          },
          { type: 'plain_text', name: RELAY_ACCOUNT_BINDING, text: upload.accountId },
          { type: 'plain_text', name: RELAY_ZONE_BINDING, text: upload.zoneId },
          {
            type: 'plain_text',
            name: RELAY_INGRESS_BINDING,
            text: upload.ingressName,
          },
        ],
      };
      const formData = new FormData();
      formData.append(
        'metadata',
        new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
      );
      formData.append(
        'index.js',
        new Blob([upload.source], { type: 'application/javascript+module' }),
        'index.js',
      );
      await call(`/accounts/${accountId}/workers/scripts/${scriptName}`, {
        method: 'PUT',
        body: formData,
      });
    },

    putRelaySecret: async (accountId, scriptName, secret) => {
      await call(`/accounts/${accountId}/workers/scripts/${scriptName}/secrets`, {
        method: 'PUT',
        body: JSON.stringify({ name: RELAY_SECRET_BINDING, text: secret, type: 'secret_text' }),
      });
    },

    getWorkersSubdomain: async (accountId) => {
      const result = await call<{ subdomain: string }>(`/accounts/${accountId}/workers/subdomain`);
      if (!result?.subdomain) {
        throw new Error('Cloudflare Workers account subdomain is unavailable');
      }
      return result.subdomain;
    },

    getScriptSubdomainEnabled: async (accountId, scriptName) => {
      const result = await call<{ enabled: boolean }>(
        `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
      );
      return result.enabled === true;
    },

    enableScriptSubdomain: async (accountId, scriptName) => {
      await call(`/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true, previews_enabled: false }),
      });
    },

    setCatchAll: async (zoneId, relayWorkerName) => {
      await call(`/zones/${zoneId}/email/routing/rules/catch_all`, {
        method: 'PUT',
        body: JSON.stringify({
          matchers: [{ type: 'all' }],
          actions: [{ type: 'worker', value: [relayWorkerName] }],
          enabled: true,
        }),
      });
    },

    getCatchAll: async (zoneId) => {
      let rule: unknown;
      try {
        rule = await call<unknown>(`/zones/${zoneId}/email/routing/rules/catch_all`);
      } catch (err) {
        if (err instanceof CloudflareApiError && err.status === 404) {
          return null;
        }
        throw err;
      }
      // cfCustomerFetch already unwrapped the envelope's `result`.
      if (!rule || typeof rule !== 'object') {
        return null;
      }
      const actions = (rule as { actions?: unknown }).actions;
      const first = Array.isArray(actions) && actions.length > 0 ? actions[0] : null;
      const workerName =
        first !== null &&
        typeof first === 'object' &&
        (first as { type?: unknown }).type === 'worker' &&
        Array.isArray((first as { value?: unknown }).value)
          ? (((first as { value: Array<unknown> }).value[0] as string | undefined) ?? null)
          : null;
      return { enabled: (rule as { enabled?: unknown }).enabled === true, workerName };
    },

    listRoutingRules: async (zoneId) => {
      const rules: Array<CfEmailRoutingRule> = [];
      for (let page = 1; page <= 20; page++) {
        const result = await call<unknown>(
          `/zones/${zoneId}/email/routing/rules?page=${page}&per_page=50`,
        );
        if (!Array.isArray(result)) {
          throw new Error('Cloudflare routing rules response was not an array');
        }
        for (const value of result) {
          rules.push(parseRoutingRule(value));
        }
        if (result.length < 50) {
          break;
        }
        if (page === 20) {
          throw new Error('Cloudflare routing rule list exceeded 1,000 entries');
        }
      }
      return rules;
    },

    getRoutingRule: async (zoneId, ruleId) => {
      try {
        return parseRoutingRule(
          await call(`/zones/${zoneId}/email/routing/rules/${encodeURIComponent(ruleId)}`),
        );
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    putLiteralRule: async (zoneId, ruleId, input) =>
      parseRoutingRule(
        await call(
          `/zones/${zoneId}/email/routing/rules${ruleId ? `/${encodeURIComponent(ruleId)}` : ''}`,
          {
            method: ruleId ? 'PUT' : 'POST',
            body: JSON.stringify({
              name: input.name,
              enabled: true,
              matchers: [{ type: 'literal', field: 'to', value: input.address }],
              actions: [{ type: 'worker', value: [input.workerName] }],
            }),
          },
        ),
      ),
    deleteRoutingRule: async (zoneId, ruleId) => {
      try {
        await call(`/zones/${zoneId}/email/routing/rules/${encodeURIComponent(ruleId)}`, {
          method: 'DELETE',
        });
      } catch (error) {
        if (!(error instanceof CloudflareApiError && error.status === 404)) {
          throw error;
        }
      }
    },
    // PATCH changes only plus-address matching; DNS and other zone settings are preserved.
    enableSubaddressing: async (zoneId) => {
      await call(`/zones/${zoneId}/email/routing`, {
        method: 'PATCH',
        body: JSON.stringify({ support_subaddress: true }),
      });
    },

    resetCatchAll: async (zoneId) => {
      await call(`/zones/${zoneId}/email/routing/rules/catch_all`, {
        method: 'PUT',
        body: JSON.stringify({
          matchers: [{ type: 'all' }],
          actions: [{ type: 'drop' }],
          enabled: false,
        }),
      });
    },

    getRoutingSettings: (zoneId) => call<unknown>(`/zones/${zoneId}/email/routing`),

    deleteRelayScript: async (accountId, scriptName) => {
      try {
        await call(`/accounts/${accountId}/workers/scripts/${scriptName}`, { method: 'DELETE' });
      } catch (err) {
        if (err instanceof CloudflareApiError && err.status === 404) {
          return;
        }
        throw err;
      }
    },
  };
}
