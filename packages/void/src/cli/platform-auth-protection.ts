import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parsePlatformAccessProtection, platformProtectionProofMessage } from '@void/platform';
import type { PlatformInstallationManifest } from '@void/platform';
import { confirm, isCancel } from '@voidzero-dev/vite-plus-prompts';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensurePlatformAccessToken } from './cf-access.ts';
import { readOperatorToken, resolveOperatorOrigin } from './operator-auth.ts';
import { OperatorClient } from './operator-client.ts';
import { printSuccess } from './output.ts';
import {
  checkpointPlatformAccessResources,
  parsePlatformAccessSetupSpec,
  preparePlatformAccessSetup,
} from './platform-access-setup.ts';
import {
  platformOperatorCredentialLabel,
  resolvePlatformCloudflareCredential,
} from './platform-auth.ts';
import { PlatformCloudflareClient } from './platform-cloudflare.ts';
import type { PlatformConfigArgs } from './platform-config-args.ts';
import { acquirePlatformDatabaseLifecycleLock } from './platform-installer.ts';
import { resolvePlatformInstallDatabaseUrl } from './platform-lifecycle.ts';
import {
  selectAuthoritativePlatformManifest,
  verifyPlatformInstallationOwnership,
} from './platform-management.ts';
import {
  acquirePlatformLifecycleLock,
  normalizePlatformApiUrl,
  promoteInstallationSecrets,
  readInstallationRecoverySecrets,
  resolveInstallationManifest,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';

/** Read every externally routed control-plane Worker before changing its preview settings. */
export async function verifyProtectionWorkerOrigins(
  client: Pick<
    PlatformCloudflareClient,
    'request' | 'listWorkerDomains' | 'listWorkerServiceRoutes'
  >,
  manifest: PlatformInstallationManifest,
  origins: ReadonlyArray<string>,
  disablePreviews: boolean,
  options: { workerNames?: ReadonlyArray<string> } = {},
): Promise<void> {
  const domains = await client.listWorkerDomains(manifest.account.id);
  const allowed = new Set(origins.map((origin) => new URL(origin).hostname));
  const workers = [
    manifest.deployment.resources.apiWorker,
    manifest.deployment.resources.proxyWorker,
    ...(manifest.resources.some(
      (resource) =>
        resource.name === manifest.deployment.resources.dashboardWorker &&
        resource.state === 'ready',
    ) || domains.some((domain) => domain.service === manifest.deployment.resources.dashboardWorker)
      ? [manifest.deployment.resources.dashboardWorker]
      : []),
  ];
  const updates: Array<{ path: string; enabled: boolean }> = [];
  for (const worker of workers) {
    if (options.workerNames && !options.workerNames.includes(worker)) {
      continue;
    }
    const path = `/accounts/${encodeURIComponent(manifest.account.id)}/workers/scripts/${encodeURIComponent(worker)}/subdomain`;
    const subdomain = await client.request<{ enabled?: unknown; previews_enabled?: unknown }>(path);
    const expectedWorkersDev = origins.some(
      (origin) =>
        new URL(origin).hostname.startsWith(`${worker}.`) &&
        new URL(origin).hostname.endsWith('.workers.dev'),
    );
    if (typeof subdomain.enabled !== 'boolean' || typeof subdomain.previews_enabled !== 'boolean') {
      throw new Error(
        'platform: Cannot verify Worker alternate origins. Check Workers read permissions.',
      );
    }
    if (subdomain.enabled && !expectedWorkersDev) {
      // Existing custom-domain installations often also expose workers.dev. Disable only after review.
      updates.push({ path, enabled: false });
    } else if (subdomain.previews_enabled) {
      updates.push({ path, enabled: expectedWorkersDev && subdomain.enabled });
    }
    for (const domain of domains.filter((domain) => domain.service === worker)) {
      if (!allowed.has(domain.hostname)) {
        throw new Error(
          `platform: Protect or remove the additional Worker domain ${domain.hostname} before enabling Access.`,
        );
      }
    }
    for (const route of await client.listWorkerServiceRoutes(manifest.account.id, worker)) {
      const hostname = route.pattern.replace(/^https?:\/\//, '').split('/')[0];
      if (!allowed.has(hostname)) {
        throw new Error(
          'platform: A control-plane Worker has an additional or wildcard route. Protect or remove it before enabling Access.',
        );
      }
    }
  }
  if (updates.length && !disablePreviews) {
    throw new Error(
      'platform: Worker alternate and preview URLs must be disabled before enabling Access.',
    );
  }
  for (const update of updates) {
    await client.request(update.path, {
      method: 'POST',
      body: JSON.stringify({ enabled: update.enabled, previews_enabled: false }),
      headers: { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' },
    });
    const current = await client.request<{ enabled?: unknown; previews_enabled?: unknown }>(
      update.path,
    );
    if (current.enabled !== update.enabled || current.previews_enabled !== false) {
      throw new Error(
        'platform: Worker alternate origins changed during protection setup. Reconcile them before retrying.',
      );
    }
  }
}

function stringList(value: unknown): Array<string> | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function protectionContext(value: Record<string, unknown>) {
  const { installationId, userId, sessionId, revision, lifecycleVersion } = value;
  const origins = stringList(value.origins);
  return typeof installationId === 'string' &&
    typeof userId === 'string' &&
    typeof sessionId === 'string' &&
    typeof revision === 'number' &&
    Number.isSafeInteger(revision) &&
    typeof lifecycleVersion === 'string' &&
    origins
    ? { installationId, userId, sessionId, revision, lifecycleVersion, origins }
    : undefined;
}

export async function runPlatformProtectionConfig(args: PlatformConfigArgs): Promise<void> {
  const manifest =
    args.target === 'show' ? undefined : resolveInstallationManifest(args.installation);
  const origin = args.connection
    ? resolveOperatorOrigin(args.connection)
    : manifest?.endpoints.apiUrl
      ? normalizePlatformApiUrl(manifest.endpoints.apiUrl)
      : resolveOperatorOrigin('');
  const operator = new OperatorClient(origin, readOperatorToken(origin));
  if (manifest) {
    const saved = readInstallationRecoverySecrets(manifest);
    const provisioning = saved?.accessProvisioningJson
      ? (JSON.parse(saved.accessProvisioningJson) as {
          resources?: { protection?: { id?: string } };
        })
      : undefined;
    if (
      manifest.deployment.authentication.accessProtection ||
      provisioning?.resources?.protection?.id
    ) {
      ensurePlatformAccessToken(origin, false, true);
    }
  }
  const live = await operator.request('/config/auth/protection');
  if (args.target === 'show') {
    console.log(JSON.stringify({ protection: live.protection, origins: live.origins }, null, 2));
    return;
  }
  let context = protectionContext(live);
  if (
    !manifest ||
    manifest.status !== 'installed' ||
    !manifest.endpoints.proxyUrl ||
    normalizePlatformApiUrl(manifest.endpoints.apiUrl ?? '') !== origin ||
    !context ||
    context.installationId !== manifest.id
  ) {
    throw new Error(
      'platform: Protection settings must belong to this completed installation. Repair or upgrade it first.',
    );
  }
  let origins = context.origins;
  if (!origins.includes(origin) || !origins.includes(new URL(manifest.endpoints.proxyUrl).origin)) {
    throw new Error(
      'platform: The live API and proxy origins differ from installation recovery state. Repair the installation first.',
    );
  }
  const spec = args.file
    ? parsePlatformAccessSetupSpec(JSON.parse(await readFile(args.file, 'utf8')))
    : undefined;
  if (args.target === 'disable' && spec) {
    throw new Error(
      'platform: Removing protection does not accept an Access application configuration.',
    );
  }
  const reviewed = {
    action: args.target,
    installationId: manifest.id,
    origin,
    origins,
    ...(spec ? { cloudflareAccess: spec } : {}),
    revokeHumanSessions: true,
    retainAccessApplications: true,
    disableUnprotectedWorkerAlternateOrigins: args.target === 'enable',
  };
  if (args.plan) {
    console.log(JSON.stringify({ dryRun: true, ...reviewed }, null, 2));
    return;
  }
  if (!args.yes) {
    console.error(JSON.stringify(reviewed, null, 2));
    if (!process.stdin.isTTY) {
      throw new Error(
        'platform: Protection changes require --yes or --plan in non-interactive mode.',
      );
    }
    const accepted = await confirm({
      message: 'Apply this protection change and revoke human sessions?',
      initialValue: false,
    });
    if (isCancel(accepted) || !accepted) {
      throw new Error('platform: Cancelled.');
    }
  }
  const release = acquirePlatformLifecycleLock(
    manifest.account.id,
    manifest.deployment.installationSlug,
  );
  try {
    let currentManifest = resolveInstallationManifest(manifest.id);
    const recovery = readInstallationRecoverySecrets(currentManifest);
    if (!recovery?.jwtSecret) {
      throw new Error(
        'platform: Restore the original encrypted installation recovery credentials before changing protection.',
      );
    }
    const credential = await resolvePlatformCloudflareCredential();
    const cloudflare = new PlatformCloudflareClient(credential.token, {
      credential: platformOperatorCredentialLabel(credential),
    });
    let protection = null;
    const checkpoint = { ...recovery };
    const save = (values: Record<string, string>) => {
      Object.assign(checkpoint, values);
      writePendingInstallationSecrets(currentManifest, checkpoint);
    };
    if (args.target === 'disable') {
      await verifyPlatformInstallationOwnership(cloudflare, currentManifest);
    }
    if (args.target === 'enable') {
      const databaseUrl = resolvePlatformInstallDatabaseUrl(recovery, currentManifest);
      if (!databaseUrl) {
        throw new Error(
          'platform: DATABASE_URL is required to checkpoint Access resource ownership safely.',
        );
      }
      const releaseDatabase = await acquirePlatformDatabaseLifecycleLock(
        databaseUrl,
        currentManifest.id,
        currentManifest.ownershipNonce,
      );
      try {
        currentManifest = selectAuthoritativePlatformManifest(
          currentManifest,
          releaseDatabase.authoritativeManifest,
        );
        if (!releaseDatabase.authoritativeManifest) {
          await releaseDatabase.checkpoint?.(currentManifest);
        } else {
          writeInstallationManifest(currentManifest);
        }
        const locked = await operator.request('/config/auth/protection');
        const lockedOrigins = stringList(locked.origins);
        if (
          normalizePlatformApiUrl(currentManifest.endpoints.apiUrl ?? '') !== origin ||
          !currentManifest.endpoints.proxyUrl ||
          locked.installationId !== currentManifest.id ||
          !lockedOrigins ||
          !lockedOrigins.includes(origin) ||
          !lockedOrigins.includes(new URL(currentManifest.endpoints.proxyUrl).origin)
        ) {
          throw new Error(
            'platform: Platform origins changed before Access provisioning. Review and retry.',
          );
        }
        origins = lockedOrigins;
        await verifyPlatformInstallationOwnership(cloudflare, currentManifest);
        await verifyProtectionWorkerOrigins(cloudflare, currentManifest, origins, true);
        const originalCredentials = process.env.VOID_ACCESS_CREDENTIALS;
        try {
          const prepared = await preparePlatformAccessSetup({
            plan: {
              account: currentManifest.account,
              installationId: currentManifest.id,
              apiUrl: origin,
              proxyUrl: currentManifest.endpoints.proxyUrl,
            },
            ownershipNonce: currentManifest.ownershipNonce,
            protection: true,
            additionalOrigins: origins,
            spec,
            client: cloudflare,
            checkpoint,
            save,
            yes: args.yes,
          });
          protection = parsePlatformAccessProtection(prepared?.protection);
          if (!protection) {
            throw new Error('platform: Access protection could not be verified.');
          }
        } finally {
          // Provisioning stores machine credentials. Management still requires the human's Access session.
          if (originalCredentials === undefined) {
            delete process.env.VOID_ACCESS_CREDENTIALS;
          } else {
            process.env.VOID_ACCESS_CREDENTIALS = originalCredentials;
          }
        }
      } finally {
        try {
          currentManifest = checkpointPlatformAccessResources(
            currentManifest,
            checkpoint.accessProvisioningJson,
            new Date().toISOString(),
          );
          writeInstallationManifest(currentManifest);
          await releaseDatabase.checkpoint?.(currentManifest);
        } finally {
          await releaseDatabase();
        }
      }
      ensurePlatformAccessToken(origin, false, true);
      if (!cfAccessHeaders(process.env, origin)['cf-access-token']) {
        throw new Error(
          'platform: Sign in interactively through company Access to enable protection. Service credentials cannot authorize this change.',
        );
      }
      // Resource checkpointing changes lifecycleVersion. Refresh it after releasing the
      // lifecycle lock, then verify the origins against that exact captured version. A
      // later lifecycle mutation makes this proof stale at the operator API.
      context = protectionContext(await operator.request('/config/auth/protection'));
      if (
        !context ||
        context.installationId !== currentManifest.id ||
        JSON.stringify(context.origins) !== JSON.stringify(origins)
      ) {
        throw new Error(
          'platform: Protection settings changed while Access resources were being checkpointed. Review and retry.',
        );
      }
      await verifyProtectionWorkerOrigins(cloudflare, currentManifest, origins, false);
    }
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const signature = createHmac('sha256', recovery.jwtSecret)
      .update(
        platformProtectionProofMessage({
          installationId: currentManifest.id,
          origin,
          userId: context.userId,
          sessionId: context.sessionId,
          revision: context.revision,
          lifecycleVersion: context.lifecycleVersion,
          protection,
          expiresAt,
        }),
      )
      .digest('base64url');
    const body = {
      revision: context.revision,
      lifecycleVersion: context.lifecycleVersion,
      protection,
      expiresAt,
      signature,
    };
    const preview = await operator.request('/config/auth/protection', {
      method: 'POST',
      body: { ...body, dryRun: true },
    });
    if (!args.json) {
      console.error(JSON.stringify(preview, null, 2));
    }
    const result = await operator.request('/config/auth/protection', { method: 'POST', body });
    writePendingInstallationSecrets(currentManifest, checkpoint);
    promoteInstallationSecrets(currentManifest);
    console.log(
      JSON.stringify({ ...result, protection, retainedAccessApplications: true }, null, 2),
    );
    if (!args.json) {
      printSuccess(
        'Platform protection updated. Sign in again with void platform auth login. Existing Access applications and policies were retained.',
      );
    }
  } finally {
    release();
  }
}
