import {
  PLATFORM_APPLICATION_KEY,
  readPlatformApplication,
  platformHealthHostname,
  type PlatformApplication,
} from '@void/platform';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { encryptPlatformCredential } from '../project-secrets.ts';
import { assertPublicGateOff } from '../security/public-gate.ts';
import {
  applicationTargetEnvironment,
  PLATFORM_APPLICATION_SETTING,
  resolveZeroTrustApplicationEnvironment,
} from './application.ts';
import { ZeroTrustCloudflareClient, publicAppManagementDestination } from './cloudflare.ts';
import {
  ZERO_TRUST_CREDENTIAL_ID,
  type ZeroTrustConfiguration,
  type ZeroTrustConfigureInput,
  parseZeroTrustApplicationTarget,
  zeroTrustConfigurationStatus,
  readZeroTrustConfigurationStrict,
  redactedZeroTrustConfiguration,
  writeZeroTrustConfiguration,
  zeroTrustWildcardDestinations,
} from './configuration.ts';
import { ZeroTrustUnavailableError } from './errors.ts';
import { lockZeroTrustConfiguration } from './lock.ts';
import {
  claimConfiguration,
  leaseActive,
  leaseExpiresAt,
  operationStartedAt,
  runConfigureOperation,
  runDisableOperation,
} from './operation.ts';
import { applicationName, installationId } from './state.ts';

/** The installer calls this only after DNS, token permissions and HTTPS are verified. */
export async function activatePlatformApplication(
  env: ApiEnv['Bindings'],
  db: Db,
  value: PlatformApplication,
): Promise<{ ready: boolean }> {
  const target = parseZeroTrustApplicationTarget(value);
  const claim = await db.transaction(async (tx) => {
    await lockZeroTrustConfiguration(tx, 'exclusive');
    const current = await readZeroTrustConfigurationStrict(tx);
    const currentEnv = await resolveZeroTrustApplicationEnvironment(env, tx, current);
    applicationTargetEnvironment(currentEnv, target);
    if (current?.operation) {
      if (
        !current.operation.applicationTarget ||
        JSON.stringify(current.operation.applicationTarget) !== JSON.stringify(target)
      ) {
        throw new ZeroTrustUnavailableError(
          'Finish the saved Zero Trust operation before adding this domain.',
        );
      }
      if (leaseActive(current.operation)) {
        return { ready: false, configuration: null };
      }
    } else {
      const completed = await getPlatformSetting(tx, PLATFORM_APPLICATION_SETTING);
      if (
        !current?.enabled ||
        (completed &&
          JSON.stringify(parseZeroTrustApplicationTarget(completed)) === JSON.stringify(target))
      ) {
        await setPlatformSetting(tx, PLATFORM_APPLICATION_SETTING, target);
        await env.ROUTING.put(PLATFORM_APPLICATION_KEY, JSON.stringify(target));
        return { ready: true, configuration: null };
      }
    }
    if (!current) {
      throw new ZeroTrustUnavailableError('Project Zero Trust configuration is unavailable.');
    }
    if (!current.publicAccess) {
      assertWildcardExcludesControlPlane(env, zeroTrustWildcardDestinations(target));
    }
    const now = new Date().toISOString();
    const configuration: ZeroTrustConfiguration = {
      ...current,
      revision: current.revision + 1,
      operation: {
        ...(current.operation ?? {
          id: crypto.randomUUID(),
          kind: 'reconcile' as const,
          phase: 'seed' as const,
          startedAt: await operationStartedAt(tx),
          existingProjects: null,
          applicationTarget: target,
        }),
        owner: crypto.randomUUID(),
        leaseExpiresAt: leaseExpiresAt(),
      },
      lastError: null,
      updatedAt: now,
    };
    await writeZeroTrustConfiguration(tx, configuration);
    return { ready: false, configuration };
  });
  if (!claim.configuration) {
    return { ready: claim.ready };
  }
  const completed = await runConfigureOperation(env, db, claim.configuration);
  return { ready: completed.operation === null };
}

function wildcardDestinationMatches(pattern: string, hostname: string): boolean {
  // Treat `*` as any non-empty text, including dots. Over-matching only
  // rejects a configuration; under-matching could gate the control plane.
  const expression = pattern
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+');
  return new RegExp(`^${expression}$`).test(hostname);
}

/**
 * The project wildcard must never cover the API, proxy or email gateway. CLI,
 * webhooks and project Workers call them without an Access session.
 */
function assertWildcardExcludesControlPlane(
  env: ApiEnv['Bindings'],
  destinations: ReadonlyArray<string>,
  requestUrl?: string,
): void {
  const hostnames = new Set<string>();
  for (const url of [requestUrl, env.AUTH_REDIRECT_URI, env.PROXY_URL, env.EMAIL_GATEWAY_ORIGIN]) {
    if (url && URL.canParse(url)) {
      hostnames.add(new URL(url).hostname.toLowerCase());
    }
  }
  for (const hostname of hostnames) {
    const pattern = destinations.find((destination) =>
      wildcardDestinationMatches(destination, hostname),
    );
    if (pattern) {
      throw new ZeroTrustUnavailableError(
        `Project Zero Trust would put the platform control plane (${hostname}) behind the project Access application ${pattern}. Serve the API, proxy and email gateway from hostnames outside the project application domain, then configure Zero Trust again.`,
      );
    }
  }
}

/**
 * The existing-project choice applies only when a configure starts from
 * disabled, or when it resumes such an operation with a replacement token.
 */
export function assertExistingProjectsChoice(
  current: ZeroTrustConfiguration | null,
  input: ZeroTrustConfigureInput,
): void {
  if (
    input.publicAccess &&
    (input.existingProjects === 'protected' ||
      input.protectNewProjects ||
      input.identityProviderIds.length ||
      input.policyIds.length)
  ) {
    throw new ZeroTrustUnavailableError(
      'Public app access cannot require identities or protect new projects.',
    );
  }
  if (input.publicAccess && current?.enabled && !current.publicAccess) {
    throw new ZeroTrustUnavailableError(
      'Disable the existing protected configuration before enabling public-only app rules.',
    );
  }
  const operation = current?.operation;
  if (operation) {
    if (
      input.existingProjects === undefined ||
      input.existingProjects === operation.existingProjects
    ) {
      return;
    }
    throw new ZeroTrustUnavailableError(
      operation.existingProjects === null
        ? 'The pending Zero Trust operation does not choose protection for existing projects. Configure again without an existing-projects choice.'
        : `The pending Zero Trust operation keeps existing projects ${operation.existingProjects}. Configure again with that choice or without one.`,
    );
  }
  if (!current?.enabled && input.existingProjects === undefined) {
    throw new ZeroTrustUnavailableError(
      'Enabling Zero Trust needs a choice for existing projects: protected or public.',
    );
  }
  if (current?.enabled && input.existingProjects !== undefined) {
    throw new ZeroTrustUnavailableError(
      'Zero Trust is already enabled, so existing projects keep their protection. Omit the existing-projects choice, and change individual projects with `void platform zero-trust project-protect` or `project-public`.',
    );
  }
}

export async function configurePlatformZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  input: ZeroTrustConfigureInput,
  options: Readonly<{ requestUrl?: string }> = {},
): Promise<ReturnType<typeof redactedZeroTrustConfiguration>> {
  // Zero Trust always uses the Cloudflare account that owns the installation.
  const accountId = env.CF_ACCOUNT_ID;
  env = await resolveZeroTrustApplicationEnvironment(env, db);
  const destinations = zeroTrustWildcardDestinations(readPlatformApplication(env));
  if (destinations.length === 0) {
    throw new ZeroTrustUnavailableError(
      'Project Zero Trust needs a platform domain or workers.dev application hostname.',
    );
  }
  const previous = await readZeroTrustConfigurationStrict(db);
  // Fail before any Cloudflare call; the claim below checks again under the lock.
  assertExistingProjectsChoice(previous, input);
  if (input.publicAccess) {
    await assertPublicGateOff(db, env);
  }
  const replacingDisableCredential = previous?.operation?.kind === 'disable';
  // A disable removes the wildcard, so a replacement credential for it must
  // not be blocked by hostnames that moved under the wildcard afterwards.
  if (!replacingDisableCredential && !input.publicAccess) {
    assertWildcardExcludesControlPlane(env, destinations, options.requestUrl);
  }
  const application = readPlatformApplication(env);
  const publicGuardHostname =
    platformHealthHostname(application) ??
    (application.workersDev && env.DISPATCH_WORKER_NAME
      ? `${env.DISPATCH_WORKER_NAME}.${application.workersDev.subdomain}.workers.dev`
      : null);
  if (input.publicAccess && !publicGuardHostname) {
    throw new ZeroTrustUnavailableError(
      'The installation’s reserved dispatch hostname is unavailable. Repair the installation before configuring public app rules.',
    );
  }
  const publicAccessGuardDestination = input.publicAccess
    ? publicAppManagementDestination('https://' + publicGuardHostname)
    : undefined;
  const client = new ZeroTrustCloudflareClient(accountId, input.apiToken);
  // Teardown needs the account credential, not the IdPs/policies being removed.
  // Those selections may themselves have disappeared while cleanup was pending.
  const selection =
    replacingDisableCredential || input.publicAccess
      ? await client.getOrganization()
      : await client.validateSelection(input);
  const credential = await encryptPlatformCredential(
    env,
    installationId(env),
    ZERO_TRUST_CREDENTIAL_ID,
    input.apiToken,
  );
  const configuration = await claimConfiguration(
    db,
    async (current, owner, startedAt) => {
      if (
        replacingDisableCredential &&
        (current?.revision !== previous.revision || current.operation?.kind !== 'disable')
      ) {
        throw new ZeroTrustUnavailableError(
          'The saved Zero Trust operation changed. Retry configuration.',
        );
      }
      assertExistingProjectsChoice(current, input);
      if (current?.operation) {
        const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
          left.length === right.length && left.every((id) => right.includes(id));
        if (
          current.accountId !== accountId ||
          !!current.publicAccess !== !!input.publicAccess ||
          current.protectNewProjects !== input.protectNewProjects ||
          !sameIds(current.identityProviderIds, input.identityProviderIds) ||
          !sameIds(current.policyIds, input.policyIds)
        ) {
          throw new ZeroTrustUnavailableError(
            'A saved Zero Trust operation is pending. To replace its API token, configure again with the same identity providers, policies, and project selections.',
          );
        }
        return {
          ...current,
          revision: current.revision + 1,
          credential,
          teamDomain: selection.teamDomain,
          operation: { ...current.operation, owner, leaseExpiresAt: leaseExpiresAt() },
          lastError: null,
          updatedAt: new Date().toISOString(),
        };
      }
      const now = new Date().toISOString();
      return {
        version: 1,
        ...(input.publicAccess
          ? { publicAccess: true as const, publicAccessGuardDestination }
          : {}),
        ...(input.managePublicCustomDomains || current?.managePublicCustomDomains
          ? { managePublicCustomDomains: true as const }
          : {}),
        revision: (current?.revision ?? 0) + 1,
        enabled: current?.enabled ?? false,
        protectNewProjects: input.protectNewProjects,
        accountId,
        teamDomain: selection.teamDomain,
        identityProviderIds: [...input.identityProviderIds],
        policyIds: [...input.policyIds],
        credential,
        // The name is kept for the installation's lifetime so a retry or a later
        // re-enable can recover the same wildcard application.
        wildcardApplicationName:
          current?.wildcardApplicationName ?? (await applicationName(env, 'project-zero-trust')),
        wildcardApplication: current?.wildcardApplication ?? null,
        healthApplicationName:
          current?.healthApplicationName ?? (await applicationName(env, 'platform-health')),
        healthApplication: current?.healthApplication ?? null,
        operation: {
          id: crypto.randomUUID(),
          kind: 'configure',
          phase: 'seed',
          owner,
          leaseExpiresAt: leaseExpiresAt(),
          startedAt,
          existingProjects: input.existingProjects ?? null,
        },
        lastError: null,
        updatedAt: now,
      };
    },
    input.publicAccess ? { refuseWhileGateOn: env } : undefined,
  );
  return redactedZeroTrustConfiguration(
    configuration.operation?.kind === 'disable'
      ? await runDisableOperation(env, db, configuration)
      : await runConfigureOperation(env, db, configuration, client, selection),
  );
}

async function claimReconcileOperation(db: Db): Promise<ZeroTrustConfiguration> {
  return claimConfiguration(db, (current, owner, startedAt) => {
    if (!current) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is not configured.');
    }
    const now = new Date().toISOString();
    if (current.operation) {
      return {
        ...current,
        revision: current.revision + 1,
        operation: {
          ...current.operation,
          owner,
          leaseExpiresAt: leaseExpiresAt(),
        },
        lastError: null,
        updatedAt: now,
      };
    }
    if (!current.enabled) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is not enabled.');
    }
    return {
      ...current,
      revision: current.revision + 1,
      operation: {
        id: crypto.randomUUID(),
        kind: 'reconcile',
        phase: 'seed',
        owner,
        leaseExpiresAt: leaseExpiresAt(),
        startedAt,
        existingProjects: null,
      },
      lastError: null,
      updatedAt: now,
    };
  });
}

export async function reconcilePlatformZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
): Promise<ReturnType<typeof redactedZeroTrustConfiguration>> {
  const configuration = await claimReconcileOperation(db);
  const result =
    configuration.operation?.kind === 'disable'
      ? await runDisableOperation(env, db, configuration)
      : await runConfigureOperation(env, db, configuration);
  return redactedZeroTrustConfiguration(result);
}

export async function disablePlatformZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
): Promise<ReturnType<typeof redactedZeroTrustConfiguration>> {
  const saved = await readZeroTrustConfigurationStrict(db);
  if (!saved) {
    return redactedZeroTrustConfiguration(null);
  }
  if (!saved.enabled && !saved.operation) {
    return redactedZeroTrustConfiguration(saved);
  }
  const configuration = await claimConfiguration(
    db,
    (current, owner, startedAt) => {
      if (!current) {
        throw new ZeroTrustUnavailableError('Project Zero Trust is not configured.');
      }
      const now = new Date().toISOString();
      return {
        ...current,
        revision: current.revision + 1,
        operation:
          current.operation?.kind === 'disable'
            ? { ...current.operation, owner, leaseExpiresAt: leaseExpiresAt() }
            : {
                id: crypto.randomUUID(),
                kind: 'disable',
                phase: 'seed',
                owner,
                leaseExpiresAt: leaseExpiresAt(),
                startedAt,
                existingProjects: null,
              },
        lastError: null,
        updatedAt: now,
      };
    },
    { refuseWhileGateOn: env },
  );
  return redactedZeroTrustConfiguration(await runDisableOperation(env, db, configuration));
}

/**
 * Resume an installation operation whose lease is free. Returns true only when
 * a batch ran to its checkpoint; a batch that throws is recorded on the
 * operation and does not own the scheduled invocation. The fast tier leaves a
 * failed operation to the hourly tier or an explicit reconcile, so a
 * persistent failure is not retried every two minutes.
 */
export async function resumePlatformZeroTrustOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  options: Readonly<{ saved?: ZeroTrustConfiguration; retryFailed?: boolean }> = {},
): Promise<boolean> {
  const configuration = options.saved ?? (await readZeroTrustConfigurationStrict(db));
  if (
    !configuration?.operation ||
    leaseActive(configuration.operation) ||
    (zeroTrustConfigurationStatus(configuration) === 'error' && !options.retryFailed)
  ) {
    return false;
  }
  await reconcilePlatformZeroTrust(env, db);
  return true;
}
