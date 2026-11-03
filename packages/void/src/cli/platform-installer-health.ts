import { setTimeout as delay } from 'node:timers/promises';
import { normalizeApplicationDomain, PLATFORM_HEALTH_HOSTNAME_LABEL } from '@void/platform';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { type PlatformHealthCheckContext } from './platform-installer-types.ts';

export class PlatformAccessBlockedError extends Error {
  constructor(url: string, context?: PlatformHealthCheckContext) {
    super(
      context?.accessProtected
        ? [
            'platform: Cloudflare Access blocked a protected platform health check (Default-Deny, error 1050).',
            `Blocked URL: ${url}`,
            'Keep employee Access protection and account-wide Default-Deny enabled.',
            'The reserved dispatch /health endpoint uses a path-only Access exception and still requires Void’s private probe token.',
            'Resume to verify the health exceptions and saved installer credentials.',
            ...(context.resumeCommand ? [`Resume: ${context.resumeCommand}`] : []),
            'https://void.cloud/guide/platform/installation/maintenance#cloudflare-access',
          ].join('\n')
        : [
            'platform: Cloudflare Access blocked the platform health checks (Default-Deny, error 1050).',
            `Blocked URL: ${url}`,
            '',
            'To make this test platform publicly reachable:',
            '',
            `1. In ${context ? `account ${JSON.stringify(context.accountName)}` : 'your Cloudflare account'}, open:`,
            '   Zero Trust → Access controls → Applications → Create new application.',
            '2. Choose Self-hosted. When adding destinations, choose Worker and select:',
            `   ${context ? context.workers.join(', ') + '.' : "This installation's API, proxy, and dispatch Workers."}`,
            '3. Add a policy: Action → Bypass; Include → Everyone.',
            context?.resumeCommand
              ? `4. Save the policy and application, then resume:\n\n   ${context.resumeCommand}`
              : '4. Save the policy and application, then rerun your platform command.',
            '',
            'This removes Cloudflare Access protection for these Workers.',
            'Void’s own authentication stays enabled. Keep account-wide Default-Deny on.',
            '',
            'For platforms that must remain Access-protected:',
            'https://void.cloud/guide/platform/installation/maintenance#cloudflare-access',
          ].join('\n'),
    );
  }
}

async function platformProbeFailure(
  label: string,
  url: string,
  response: Response,
  context?: PlatformHealthCheckContext,
): Promise<Error> {
  const message = `platform: ${label} failed at ${url} (HTTP ${response.status}).`;
  if (
    response.status === 403 &&
    response.headers.get('server')?.toLowerCase() === 'cloudflare' &&
    response.headers.get('content-type')?.toLowerCase().includes('text/html')
  ) {
    const body = await response.text().catch(() => '');
    if (body.includes('Default-Deny') && /errorCode:\s*1050\b/.test(body)) {
      return new PlatformAccessBlockedError(url, context);
    }
  }
  return new Error(message);
}

export async function verifyPlatformHealth(
  apiUrl: string,
  installationId: string,
  proxyUrl: string,
  applicationBaseDomain: string,
  platformVersion: string,
  usageProtocolVersion: 0 | 1 | 2,
  healthProbeToken: string,
  fetcher: typeof fetch = fetch,
  dispatchOrigin?: string,
  context?: PlatformHealthCheckContext,
): Promise<void> {
  const request = async (url: string): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetcher(url, {
          headers: {
            'X-Void-Platform-Probe': healthProbeToken,
            ...cfAccessHeaders(process.env, url),
          },
          // A login redirect must not forward the installation's probe credential.
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (attempt === 2) {
          throw new Error(`platform: Health check could not reach ${url} after 3 attempts.`, {
            cause: error,
          });
        }
        await delay(250 * (attempt + 1));
      }
    }
  };
  // Project Zero Trust leaves only this application-domain hostname outside Access.
  const dispatchUrl =
    dispatchOrigin ?? `https://${PLATFORM_HEALTH_HOSTNAME_LABEL}.${applicationBaseDomain}`;
  const [health, discovery, proxy, dispatch, emailGateway] = await Promise.all([
    request(`${apiUrl}/health`),
    request(`${apiUrl}/.well-known/void-platform`),
    request(`${proxyUrl}/health`),
    request(`${dispatchUrl}/health`),
    context?.emailGatewayUrl ? request(`${context.emailGatewayUrl}/health`) : undefined,
  ]);
  if (!health.ok) {
    throw await platformProbeFailure('Health check', `${apiUrl}/health`, health, context);
  }
  if (!discovery.ok) {
    throw await platformProbeFailure(
      'Discovery check',
      `${apiUrl}/.well-known/void-platform`,
      discovery,
      context,
    );
  }
  const body = (await discovery.json()) as {
    installationId?: unknown;
    platformVersion?: unknown;
    usageProtocolVersion?: unknown;
  };
  if (body.installationId !== installationId) {
    throw new Error('platform: Deployed API discovery identity does not match this installation.');
  }
  if (body.platformVersion !== platformVersion) {
    throw new Error('platform: Deployed API discovery version does not match this release.');
  }
  if ((body.usageProtocolVersion ?? 0) !== usageProtocolVersion) {
    throw new Error(
      'platform: Deployed API usage protocol does not match this runtime. Traffic remains disabled.',
    );
  }
  if (!proxy.ok) {
    throw await platformProbeFailure('Proxy health check', `${proxyUrl}/health`, proxy, context);
  }
  if (!dispatch.ok) {
    throw await platformProbeFailure(
      'Dispatch health check',
      `${dispatchUrl}/health`,
      dispatch,
      context,
    );
  }
  if (emailGateway) {
    if (!emailGateway.ok) {
      throw await platformProbeFailure(
        'Email gateway health check',
        `${context!.emailGatewayUrl!}/health`,
        emailGateway,
        context,
      );
    }
    const identity = (await emailGateway.json()) as {
      installationId?: unknown;
      platformVersion?: unknown;
      emailProtocolVersion?: unknown;
    } | null;
    if (
      identity?.installationId !== installationId ||
      identity.platformVersion !== platformVersion ||
      identity.emailProtocolVersion !== 1
    ) {
      throw new Error(
        'platform: Deployed email gateway identity, version, or protocol does not match this installation.',
      );
    }
  }
}

export async function verifyPlatformSandboxDrain(
  apiUrl: string,
  healthProbeToken: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(`${apiUrl}/internal/platform/sandbox-drain`, {
    headers: {
      'X-Void-Platform-Probe': healthProbeToken,
      ...cfAccessHeaders(process.env, apiUrl),
    },
    signal: AbortSignal.timeout(30_000),
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new Error(
      `platform: Sandbox drain probe failed at ${apiUrl} (HTTP ${response.status}). Traffic remains disabled.`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      'platform: Sandbox drain probe did not return its DB-backed protocol v1 document. Traffic remains disabled.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'platform: Sandbox drain probe returned an invalid DB-backed protocol v1 document. Traffic remains disabled.',
    );
  }
  const status = value as Record<string, unknown>;
  const validState =
    status.state === 'required' || status.state === 'draining' || status.state === 'complete';
  const validPhase =
    status.phase === null || status.phase === 'deployments' || status.phase === 'resources';
  if (
    status.version !== 1 ||
    !validState ||
    typeof status.complete !== 'boolean' ||
    !validPhase ||
    (status.generation !== null &&
      (typeof status.generation !== 'string' || status.generation.length === 0)) ||
    (status.updatedAt !== null &&
      (typeof status.updatedAt !== 'string' || !Number.isFinite(Date.parse(status.updatedAt)))) ||
    (status.state === 'required' &&
      (status.complete ||
        status.generation !== null ||
        status.updatedAt !== null ||
        status.phase !== null)) ||
    (status.state === 'draining' &&
      (status.complete ||
        typeof status.generation !== 'string' ||
        typeof status.updatedAt !== 'string' ||
        status.phase === null)) ||
    (status.state === 'complete' &&
      (!status.complete ||
        typeof status.generation !== 'string' ||
        typeof status.updatedAt !== 'string' ||
        status.phase === null))
  ) {
    throw new Error(
      'platform: Sandbox drain probe returned an invalid DB-backed protocol v1 document. Traffic remains disabled.',
    );
  }
  return status.state === 'complete';
}

export async function verifyPlatformDeploymentExecutionDrain(
  apiUrl: string,
  healthProbeToken: string,
  installationId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${apiUrl}/__void/platform/deployment-execution`, {
    headers: {
      'X-Void-Platform-Probe': healthProbeToken,
      ...cfAccessHeaders(process.env, apiUrl),
    },
    signal: AbortSignal.timeout(30_000),
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new Error(
      `platform: Deployment execution drain probe failed (HTTP ${response.status}). Keep the current runtime until its durable deployment operations have drained.`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('platform: Deployment execution drain probe returned an invalid document.');
  }
  const status =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    status?.protocolVersion !== 1 ||
    status.installationId !== installationId ||
    typeof status.admissionClosed !== 'boolean' ||
    !Number.isSafeInteger(status.pendingDeployments) ||
    Number(status.pendingDeployments) < 0
  ) {
    throw new Error('platform: Deployment execution drain probe returned an invalid document.');
  }
  if (!status.admissionClosed || status.pendingDeployments !== 0) {
    throw new Error(
      'platform: Durable deployment operations are still admitted or unfinished. Keep the current runtime and retry this command after they finish.',
    );
  }
}

// The Cloudflare permission that each shared email step uses with the runtime
// token: Email Routing DNS and settings need Zone Settings, and the sender
// onboarding needs Email Sending.
const sharedEmailStepPermissions: ReadonlyMap<string, string> = new Map([
  ['routing_enable', 'Zone → Zone Settings → Edit'],
  ['subaddressing_ensure', 'Zone → Zone Settings → Edit'],
  ['inbound_probe', 'Zone → Zone Settings → Edit'],
  ['sending_onboard', 'Account → Email Sending → Edit'],
]);

export async function bootstrapPlatformSharedEmail(
  apiUrl: string,
  healthProbeToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  // One bootstrap request drives several durable PostgreSQL/provider steps.
  // A timeout does not cancel its recorded operation; replay the same endpoint
  // so its idempotency key and step leases reconcile rather than repeat writes.
  const deadline = Date.now() + 5 * 60_000;
  let operationId: string | null = null;
  const timedOut = () =>
    new Error(
      `platform: Shared email bootstrap did not finish within five minutes at ${apiUrl}.${operationId ? ` Operation ${operationId} remains incomplete.` : ''} Traffic remains disabled. Retry the installation's repair or resume command to reconcile the existing email operation.`,
    );
  const waitForProgress = async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw timedOut();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1_000, remaining)));
  };
  let response: Response;
  let value: unknown;
  let status: Record<string, unknown> | null;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw timedOut();
    }
    const signal = AbortSignal.timeout(Math.min(120_000, remaining));
    try {
      response = await fetcher(`${apiUrl}/internal/platform/email-bootstrap`, {
        method: 'POST',
        headers: {
          'X-Void-Platform-Probe': healthProbeToken,
          ...cfAccessHeaders(process.env, apiUrl),
        },
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        await waitForProgress();
        continue;
      }
      throw new Error(
        `platform: Shared email bootstrap request failed at ${apiUrl}. Traffic remains disabled. Retry the installation's repair or resume command to reconcile the existing email operation.`,
      );
    }
    try {
      value = await response.json();
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        await waitForProgress();
        continue;
      }
      throw new Error(
        `platform: Shared email bootstrap failed at ${apiUrl} (HTTP ${response.status}). Traffic remains disabled.`,
      );
    }
    status =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const observedOperationId =
      typeof status?.operationId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(status.operationId)
        ? status.operationId
        : null;
    if (status?.version === 1 && observedOperationId) {
      if (operationId && operationId !== observedOperationId) {
        throw new Error(
          'platform: Shared email bootstrap operation identity changed while waiting. Traffic remains disabled. Inspect the installation before retrying.',
        );
      }
      operationId = observedOperationId;
    }
    if (
      [200, 202, 503].includes(response.status) &&
      status?.version === 1 &&
      status.state === 'incomplete' &&
      observedOperationId &&
      (status.operationStatus === 'pending' || status.operationStatus === 'running') &&
      status.failureCode == null
    ) {
      await waitForProgress();
      continue;
    }
    break;
  }
  if (
    !response.ok ||
    status?.version !== 1 ||
    status.state !== 'ready' ||
    operationId === null ||
    status.operationId !== operationId ||
    (status.operationStatus != null && status.operationStatus !== 'completed') ||
    status.failureCode != null
  ) {
    const code = (value: unknown) =>
      typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : null;
    const operationStatus = code(status?.operationStatus);
    const operationId =
      typeof status?.operationId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(status.operationId)
        ? status.operationId
        : null;
    const details = operationId
      ? [`Operation ${operationId}: ${operationStatus ?? 'incomplete'}.`]
      : operationStatus
        ? [`Operation status: ${operationStatus}.`]
        : [];
    const currentStep = code(status?.currentStep);
    const failureCode = code(status?.failureCode);
    if (currentStep) {
      details.push(`Step: ${currentStep}.`);
    }
    if (failureCode) {
      details.push(`Failure: ${failureCode}.`);
    }
    let domain: string | null = null;
    if (typeof status?.domain === 'string') {
      try {
        domain = normalizeApplicationDomain(status.domain);
      } catch {
        // Provider bodies are not diagnostic authority; show only a valid domain.
      }
    }
    const inboundStatus = code(status?.inboundStatus);
    if (domain) {
      details.push(`Domain: ${domain}${inboundStatus ? ` (inbound: ${inboundStatus})` : ''}.`);
    }
    const mxDetail = domain
      ? `MX records for ${domain} do not route mail to Cloudflare Email Routing`
      : null;
    const safeDetails = [
      ...(domain
        ? [mxDetail, `enabled explicit Cloudflare email rules conflict with ${domain}`]
        : []),
      'zone catch-all does not point to this ingress',
      'another enabled catch-all owns this zone',
    ];
    if (typeof status?.failureDetail === 'string' && safeDetails.includes(status.failureDetail)) {
      details.push(`${status.failureDetail}.`);
      if (currentStep === 'inbound_probe' && status.failureDetail === mxDetail) {
        details.push(
          `Enable Email Routing for ${domain} in the Cloudflare dashboard, then resume this installation.`,
        );
      }
    } else if (
      failureCode === 'blocked' &&
      currentStep &&
      sharedEmailStepPermissions.has(currentStep)
    ) {
      // A blocked step got a definite 4xx answer, often a missing permission.
      // The API does not return provider text, so name the permission that the
      // step uses.
      const permission = sharedEmailStepPermissions.get(currentStep);
      details.push(
        `This step needs ${permission} on the runtime API token. If the token does not have it, edit the token in the Cloudflare dashboard and add it. The token value stays the same. Or set VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN to a token that has it. Then resume this installation.`,
      );
    }
    const detail = details.length ? ` ${details.join(' ')}` : '';
    throw new Error(
      `platform: Shared email bootstrap did not reach inbound readiness at ${apiUrl} (HTTP ${response.status}).${detail} Traffic remains disabled.`,
    );
  }
  return operationId;
}
