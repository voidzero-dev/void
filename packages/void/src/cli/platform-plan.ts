import { createHash } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  createApplicationRoutes,
  createPlatformResourceOwnershipMarker,
  createPlatformResourceNames,
  normalizeApplicationDomain,
  normalizePlatformDashboardUrl,
  normalizeInstallationSlug,
  platformDashboardUrl,
  parsePlatformInstallationManifest,
  parsePlatformResourceOwnershipMarker,
  PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  type InstallationResource,
  type InstallationResourceKind,
  type PlatformAppAccess,
  type PlatformDeploymentManifest,
  type PlatformInstallationManifest,
} from '@void/platform';
import { pc } from './output.ts';
import {
  PlatformCloudflareApiError,
  PlatformCloudflarePrerequisiteError,
} from './platform-cloudflare.ts';
import type {
  CloudflareAccount,
  CloudflareDnsRecord,
  CloudflareNamedResource,
  CloudflareWorkerDomain,
  CloudflareWorkerRoute,
  CloudflareZone,
  PlatformCloudflareClient,
} from './platform-cloudflare.ts';

export type PlatformInstallPlanAction = Readonly<{
  action: 'adopt' | 'create' | 'reuse' | 'update' | 'inspect';
  id: string | null;
  key: string;
  kind: InstallationResourceKind;
  name: string;
  reason: string;
}>;

export type PlatformInstallPlan = Readonly<{
  appAccessSetupRequired?: boolean;
  account: CloudflareAccount;
  actions: ReadonlyArray<PlatformInstallPlanAction>;
  apiUrl: string;
  deployment: PlatformDeploymentManifest;
  externalHyperdrive?: PlatformExternalHyperdrive;
  installationId: string;
  proxyUrl: string;
  workersSubdomain: string;
  zone: CloudflareZone | null;
}>;

export type PlatformExternalHyperdrive = Readonly<{
  id: string;
  name?: string;
  database?: string;
  host: string;
  user: string;
}>;

type PlatformInstallPlanInput = Readonly<{
  appAccess?: PlatformAppAccess;
  authentication?: PlatformDeploymentManifest['authentication'];
  accountId: string;
  applicationDomain: string;
  controlPlaneDomain: string;
  dashboardUrl?: string;
  customDomains?: boolean;
  dedicatedZone: boolean;
  displayName: string;
  externalHyperdrive?: PlatformExternalHyperdrive;
  emailSharedZoneId?: string;
  emailSenderDomain?: string;
  installationSlug: string;
  zoneName: string;
  workersDev?: boolean;
}>;

type PlanningClient = Pick<
  PlatformCloudflareClient,
  | 'findZone'
  | 'findZoneForHostname'
  | 'getKvValue'
  | 'getR2Object'
  | 'getWorkerPlainTextBindings'
  | 'getWorkersSubdomain'
  | 'hasActiveCertificateForHostname'
  | 'listAiGateways'
  | 'listAccounts'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
  | 'listWorkerDomains'
  | 'listWorkerRoutes'
>;

export async function createPlatformInstallPlan(
  client: PlanningClient,
  input: PlatformInstallPlanInput,
  existing: PlatformInstallationManifest | null,
  options?: {
    authoritativeProvisionIntents?: boolean;
    repairMissing?: boolean;
    allowUnverifiedAiGateway?: boolean;
    includeEmailGateway?: boolean;
    enableSandbox?: boolean;
    deploymentExecution?: boolean;
  },
): Promise<PlatformInstallPlan> {
  // Validate before even the first provider read; omission retains recorded intent.
  const dashboardUrl =
    input.dashboardUrl !== undefined
      ? normalizePlatformDashboardUrl(input.dashboardUrl)
      : existing
        ? (existing.deployment.controlPlane.dashboardUrl ??
          (existing.endpoints.dashboardUrl
            ? normalizePlatformDashboardUrl(existing.endpoints.dashboardUrl)
            : null) ??
          platformDashboardUrl(existing.deployment))
        : null;
  const accounts = await client.listAccounts();
  const account = resolveAccount(accounts, input.accountId);
  if (existing && existing.account.id !== account.id) {
    throw new Error(
      `platform: Refusing to resume installation ${existing.id} in a different Cloudflare account.`,
    );
  }
  const providedEmailSharedZoneId = input.emailSharedZoneId?.trim();
  const providedEmailSenderDomain = input.emailSenderDomain?.trim();
  if (
    existing?.deployment.emailSharedZoneId &&
    providedEmailSharedZoneId &&
    existing.deployment.emailSharedZoneId !== providedEmailSharedZoneId
  ) {
    throw new Error('platform: The shared email zone is already recorded for this installation.');
  }
  if (
    existing?.deployment.emailSenderDomain &&
    providedEmailSenderDomain &&
    existing.deployment.emailSenderDomain !== normalizeApplicationDomain(providedEmailSenderDomain)
  ) {
    throw new Error(
      'platform: The shared email sender domain is already recorded for this installation.',
    );
  }
  const installationSlug = normalizeInstallationSlug(input.installationSlug);
  const installationId =
    existing?.id ??
    `${installationSlug}-${createHash('sha256')
      .update(
        JSON.stringify({
          accountId: account.id,
          applicationDomain: input.applicationDomain,
          controlPlaneDomain: input.controlPlaneDomain,
          installationSlug,
          zoneName: input.zoneName,
        }),
      )
      .digest('hex')
      .slice(0, 12)}`;
  const accountSubdomain = await client.getWorkersSubdomain(account.id);
  const workersDev =
    existing?.deployment.application.workersDev ??
    (input.workersDev ? { subdomain: accountSubdomain, installationId } : undefined);
  if (workersDev && workersDev.subdomain !== accountSubdomain) {
    throw new Error(
      'platform: The account workers.dev subdomain changed. Restore it before continuing.',
    );
  }
  const testing = !!workersDev && !input.zoneName;
  const emailSharedZoneId = (
    existing?.deployment.emailSharedZoneId ?? providedEmailSharedZoneId
  )?.trim();
  const emailSenderDomain = existing?.deployment.emailSenderDomain ?? providedEmailSenderDomain;
  if (!!emailSharedZoneId !== !!emailSenderDomain) {
    throw new Error(
      'platform: Set VOID_EMAIL_SENDER_DOMAIN and VOID_EMAIL_SHARED_ZONE_ID together to enable email.',
    );
  }
  const normalizedEmailSenderDomain = emailSenderDomain
    ? normalizeApplicationDomain(emailSenderDomain)
    : undefined;
  const enableEmail =
    options?.includeEmailGateway !== false && !!emailSharedZoneId && !!normalizedEmailSenderDomain;
  const capabilities = {
    ...existing?.deployment.capabilities,
    ...(options?.enableSandbox ? { sandbox: true } : {}),
    ...(input.authentication
      ? {
          githubOAuth: input.authentication.providers.includes('github'),
          googleOAuth: input.authentication.providers.includes('google'),
        }
      : {}),
    ...(enableEmail ? { email: true } : {}),
    ...(input.customDomains ? { customDomains: true } : {}),
  };
  // Custom hostnames reach dispatch through the dedicated zone's catch-all routes.
  if (capabilities.customDomains && (testing || !input.dedicatedZone)) {
    throw new Error(
      'platform: Custom domains need a dedicated application zone. Install with a domain and --dedicated-zone.',
    );
  }
  if (capabilities.email && options?.includeEmailGateway !== false && !enableEmail) {
    throw new Error(
      'platform: Email-enabled installations require VOID_EMAIL_SENDER_DOMAIN and VOID_EMAIL_SHARED_ZONE_ID before deploying this runtime.',
    );
  }
  if (
    input.appAccess &&
    input.appAccess !== 'public' &&
    input.controlPlaneDomain
      .toLowerCase()
      .replace(/\.$/, '')
      .endsWith(`.${input.applicationDomain.toLowerCase()}`)
  ) {
    throw new Error(
      'platform: The API hostname must be outside the app Access wildcard. Use the application domain apex or workers.dev for the API, then plan again.',
    );
  }
  const deployment = createPlatformDeploymentManifest({
    authentication: input.authentication ?? existing?.deployment.authentication,
    appAccess: input.appAccess ?? existing?.deployment.appAccess,
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    application: {
      baseDomain: testing ? `${accountSubdomain}.workers.dev` : input.applicationDomain,
      dedicatedZone: input.dedicatedZone,
      zoneName: input.zoneName,
      ...(workersDev ? { workersDev } : {}),
      ...(existing?.deployment.application.zoneId
        ? { zoneId: existing.deployment.application.zoneId }
        : {}),
    },
    controlPlane: {
      apiHostname: input.controlPlaneDomain || null,
      dashboardHostname: dashboardUrl ? new URL(dashboardUrl).hostname : null,
      ...(dashboardUrl ? { dashboardUrl } : {}),
      proxyHostname: null,
    },
    displayName: input.displayName,
    ...(emailSharedZoneId ? { emailSharedZoneId } : {}),
    ...(normalizedEmailSenderDomain ? { emailSenderDomain: normalizedEmailSenderDomain } : {}),
    installationSlug,
    resources: existing?.deployment.resources ?? createPlatformResourceNames(installationSlug),
  });
  const {
    emailSharedZoneId: configuredEmailZone,
    emailSenderDomain: configuredSenderDomain,
    ...deploymentWithoutEmailZone
  } = deployment;
  const {
    emailSharedZoneId: recordedEmailZone,
    emailSenderDomain: recordedSenderDomain,
    ...existingWithoutEmailZone
  } = existing?.deployment ?? deployment;
  const existingWithSandbox =
    existing && options?.enableSandbox
      ? {
          ...existingWithoutEmailZone,
          capabilities: { ...existingWithoutEmailZone.capabilities, sandbox: true },
        }
      : existingWithoutEmailZone;
  const existingWithDashboard = {
    ...existingWithSandbox,
    // The dashboard is separately deployed. Only the explicit option or the
    // normalized recorded origin can update this configuration during maintenance.
    controlPlane: {
      ...existingWithSandbox.controlPlane,
      dashboardHostname: deployment.controlPlane.dashboardHostname,
      ...(deployment.controlPlane.dashboardUrl
        ? { dashboardUrl: deployment.controlPlane.dashboardUrl }
        : {}),
    },
  };
  const existingWithCustomDomains =
    existing &&
    deployment.capabilities.customDomains &&
    !existing.deployment.capabilities.customDomains
      ? {
          ...existingWithDashboard,
          capabilities: { ...existingWithDashboard.capabilities, customDomains: true },
        }
      : existingWithDashboard;
  const comparableExistingWithoutEmailZone =
    existing && deployment.capabilities.email && !existing.deployment.capabilities.email
      ? {
          ...existingWithCustomDomains,
          capabilities: { ...existingWithCustomDomains.capabilities, email: true },
        }
      : existingWithCustomDomains;
  if (
    existing &&
    (JSON.stringify(comparableExistingWithoutEmailZone) !==
      JSON.stringify(deploymentWithoutEmailZone) ||
      (recordedEmailZone !== undefined && recordedEmailZone !== configuredEmailZone) ||
      (recordedSenderDomain !== undefined && recordedSenderDomain !== configuredSenderDomain))
  ) {
    throw new Error(
      `platform: --resume inputs do not match installation ${existing.id}. Use its recorded configuration.`,
    );
  }

  const names = deployment.resources;
  const wildcardHostname = `*.${deployment.application.baseDomain}`;
  const zone = testing ? null : await client.findZone(account.id, deployment.application.zoneName);
  if (!testing && deployment.application.baseDomain !== deployment.application.zoneName) {
    const certificateHelp =
      `Use the zone apex ${deployment.application.zoneName} as --application-domain, or provision an active ${wildcardHostname} edge certificate in the existing zone before installing. ` +
      'Cloudflare Advanced Certificate Manager is a paid add-on; an existing custom wildcard certificate also works. ' +
      `Manage certificates at https://dash.cloudflare.com/${account.id}/${deployment.application.zoneName}/ssl-tls/edge-certificates. ` +
      'Certificate inspection requires Zone > SSL and Certificates > Read (or Edit) on this zone.';
    if (!zone || zone.status !== 'active') {
      throw new Error(
        `platform: Nested application domain ${deployment.application.baseDomain} needs an active zone and wildcard certificate. ${certificateHelp}`,
      );
    }
    let covered: boolean;
    try {
      covered = await client.hasActiveCertificateForHostname(zone.id, wildcardHostname);
    } catch (error) {
      throw new Error(
        `platform: Could not verify edge certificate coverage for ${wildcardHostname}. ${certificateHelp}`,
        { cause: error },
      );
    }
    if (!covered) {
      throw new Error(
        `platform: No active edge certificate covers ${wildcardHostname}. Universal SSL for ${deployment.application.zoneName} does not cover these deeper application hostnames. ${certificateHelp}`,
      );
    }
  }
  let needsAiGatewayCredential = false;
  const gatewayInventory = client.listAiGateways(account.id).catch((error) => {
    if (
      options?.allowUnverifiedAiGateway &&
      error instanceof PlatformCloudflareApiError &&
      error.status === 403
    ) {
      needsAiGatewayCredential = true;
      return [];
    }
    throw error;
  });
  const prerequisites: Array<PlatformCloudflarePrerequisiteError> = [];
  const collectPrerequisite = (error: unknown): [] => {
    if (!(error instanceof PlatformCloudflarePrerequisiteError)) {
      throw error;
    }
    prerequisites.push(error);
    return [];
  };
  const [
    aiGateways,
    routingKv,
    isrKv,
    legacyKv,
    r2Buckets,
    usageQueues,
    cronQueues,
    deploymentQueues,
    dispatchNamespaces,
    hyperdrives,
    workers,
  ] = await Promise.all([
    gatewayInventory,
    client.listKvNamespaces(account.id, names.routingKv),
    client.listKvNamespaces(account.id, names.isrCacheKv),
    client.listKvNamespaces(account.id, names.legacyAssetsKv),
    client.listR2Buckets(account.id).catch(collectPrerequisite),
    client.listQueues(account.id, names.usageQueue),
    client.listQueues(account.id, names.cronQueue),
    (options?.deploymentExecution ??
    existing?.resources.some((resource) => resource.key === 'deployment-queue'))
      ? client.listQueues(account.id, names.deploymentQueue)
      : Promise.resolve([]),
    client.listDispatchNamespaces(account.id).catch(collectPrerequisite),
    client.listHyperdriveConfigs(account.id),
    client.listWorkerNames(account.id),
  ]);
  if (prerequisites.length === 1) {
    throw prerequisites[0];
  }
  if (prerequisites.length > 1) {
    throw new AggregateError(
      prerequisites,
      `platform: Cloudflare account prerequisites are missing:\n\n${prerequisites.map((error) => error.message).join('\n\n')}`,
    );
  }
  const dnsRecords = zone ? await listZoneDnsRecords(client, zone, wildcardHostname) : [];
  const remoteOwnership = existing
    ? await readRemoteOwnership(client, account.id, routingKv, existing)
    : null;
  const intentProofs = new Set<string>();
  const ambiguousResources = new Set<string>();
  if (existing) {
    const bucket = r2Buckets.find((resource) => resource.name === names.assetsBucket);
    const recordedBucket = existing.resources.find(
      (resource) =>
        resource.key === 'assets-bucket' &&
        resource.kind === 'r2-bucket' &&
        resource.ownership === 'created' &&
        resource.state === 'ready',
    );
    if (bucket && recordedBucket?.id === bucket.id && recordedBucket.name === bucket.name) {
      const marker = await client.getR2Object(
        account.id,
        bucket.name,
        PLATFORM_R2_OWNERSHIP_MARKER_KEY,
      );
      if (
        resourceMarkerProblem(marker, existing, {
          id: bucket.id,
          key: 'assets-bucket',
          kind: 'r2-bucket',
          name: bucket.name,
        }) ||
        !matchesRecordedR2Fingerprint(recordedBucket.configHash, bucket)
      ) {
        ambiguousResources.add('assets-bucket');
      }
    }
    if (
      bucket &&
      hasUnrecordedProvisionIntent(existing, 'assets-bucket', 'r2-bucket', bucket.name)
    ) {
      const marker = await client.getR2Object(
        account.id,
        bucket.name,
        PLATFORM_R2_OWNERSHIP_MARKER_KEY,
      );
      if (
        !resourceMarkerProblem(marker, existing, {
          id: bucket.id,
          key: 'assets-bucket',
          kind: 'r2-bucket',
          name: bucket.name,
        })
      ) {
        intentProofs.add('assets-bucket');
      }
    }
    for (const [key, name] of [
      ['api-worker', names.apiWorker],
      ['proxy-worker', names.proxyWorker],
      ['email-gateway-worker', names.emailGatewayWorker],
      ['tail-worker', names.tailWorker],
      ['dispatch-worker', names.dispatchWorker],
    ] as const) {
      if (workers.includes(name) && hasUnrecordedProvisionIntent(existing, key, 'worker', name)) {
        const bindings = await client.getWorkerPlainTextBindings(account.id, name);
        if (
          !resourceMarkerProblem(bindings.PLATFORM_OWNERSHIP_MARKER, existing, {
            id: name,
            key,
            kind: 'worker',
            name,
          })
        ) {
          intentProofs.add(key);
        }
      }
    }
  }
  if (zone) {
    const expectedPatterns = new Set(
      createApplicationRoutes(deployment.application).map((route) => route.pattern),
    );
    const expectedWorker = deployment.resources.dispatchWorker;
    const ownedWorker =
      intentProofs.has('dispatch-worker') ||
      existing?.resources.some(
        (resource) =>
          resource.key === 'dispatch-worker' &&
          resource.kind === 'worker' &&
          resource.name === expectedWorker &&
          resource.state === 'ready',
      );
    const [workerRoutes, workerDomains] = await Promise.all([
      client.listWorkerRoutes(zone.id),
      client.listWorkerDomains(account.id),
    ]);
    const conflicts = workerRoutes.filter(
      (route) =>
        expectedPatterns.has(route.pattern) && (route.script !== expectedWorker || !ownedWorker),
    );
    if (conflicts.length > 0) {
      const conflict = conflicts[0]!;
      throw new Error(
        `platform: Application route ${JSON.stringify(conflict.pattern)} is already assigned to ${JSON.stringify(conflict.script ?? 'no Worker')}. Choose another application domain.`,
      );
    }
    assertApplicationRoutesPreserveWorkerDomains(
      [...expectedPatterns],
      expectedWorker,
      ownedWorker === true,
      zone.name,
      workerRoutes,
      workerDomains,
    );
  }
  if (deployment.controlPlane.apiHostname) {
    const apiHostname = deployment.controlPlane.apiHostname;
    const [workerDomains, controlPlaneZone] = await Promise.all([
      client.listWorkerDomains(account.id),
      client.findZoneForHostname(account.id, apiHostname),
    ]);
    const matchingDomain = workerDomains.find((domain) => domain.hostname === apiHostname);
    const expectedWorker = deployment.resources.apiWorker;
    if (matchingDomain && matchingDomain.service !== expectedWorker) {
      throw new Error(
        `platform: Custom API hostname ${JSON.stringify(apiHostname)} is already assigned to Worker ${JSON.stringify(matchingDomain.service)}. Choose another hostname.`,
      );
    }
    const records = controlPlaneZone
      ? await listZoneDnsRecords(client, controlPlaneZone, apiHostname)
      : [];
    const ownedApiWorker =
      intentProofs.has('api-worker') ||
      existing?.resources.some(
        (resource) =>
          resource.key === 'api-worker' &&
          resource.kind === 'worker' &&
          resource.name === expectedWorker &&
          resource.state === 'ready',
      );
    if (records.length > 0 && (!matchingDomain || !ownedApiWorker)) {
      throw new Error(
        `platform: Custom API hostname ${JSON.stringify(apiHostname)} already has a DNS record that installation would replace. Choose another hostname or remove the record explicitly.`,
      );
    }
  }
  const actions: Array<PlatformInstallPlanAction> = [];
  const named: NamedPlanContext = {
    actions,
    existing,
    options,
    remoteOwnership,
    intentProofs,
    ambiguousResources,
  };
  if (!testing) {
    const recordedZone = existing?.resources.find((resource) => resource.key === 'zone');
    const remotelyOwnedZone = remoteOwnership?.resources.some(
      (resource) => resource.key === 'zone' && resource.id === zone?.id,
    );
    const repairCreatedZone =
      options?.repairMissing && recordedZone?.ownership === 'created' && !zone;
    if (
      recordedZone &&
      !repairCreatedZone &&
      (!zone || recordedZone.id !== zone.id || recordedZone.kind !== 'zone')
    ) {
      throw new Error(
        `platform: Recorded zone ${recordedZone.name} (${recordedZone.id}) no longer matches the Cloudflare account.`,
      );
    }
    actions.push({
      action: repairCreatedZone
        ? 'create'
        : recordedZone || (zone && remotelyOwnedZone)
          ? 'reuse'
          : zone
            ? 'adopt'
            : 'create',
      id: zone?.id ?? null,
      key: 'zone',
      kind: 'zone',
      name: deployment.application.zoneName,
      reason: repairCreatedZone
        ? 'Recreate the missing installer-owned zone.'
        : recordedZone || remotelyOwnedZone
          ? 'Reuse the recorded zone.'
          : zone
            ? 'Use the existing zone without taking ownership.'
            : 'Create the requested zone.',
    });
    addDnsPlan(actions, existing, wildcardHostname, dnsRecords, options);
  }
  if (needsAiGatewayCredential) {
    actions.push({
      action: 'inspect',
      id: null,
      key: 'ai-gateway',
      kind: 'ai-gateway',
      name: names.aiGateway,
      reason:
        'AI Gateway access will be verified with the runtime token before provisioning (AI Gateway: Edit required).',
    });
  } else {
    addNamedPlan(named, {
      key: 'ai-gateway',
      kind: 'ai-gateway',
      name: names.aiGateway,
      matches: aiGateways.filter((resource) => resource.id === names.aiGateway),
    });
  }
  addNamedPlan(named, {
    key: 'routing-kv',
    kind: 'kv-namespace',
    name: names.routingKv,
    matches: routingKv,
  });
  addNamedPlan(named, {
    key: 'isr-cache-kv',
    kind: 'kv-namespace',
    name: names.isrCacheKv,
    matches: isrKv,
  });
  addNamedPlan(named, {
    key: 'legacy-assets-kv',
    kind: 'kv-namespace',
    name: names.legacyAssetsKv,
    matches: legacyKv,
  });
  addNamedPlan(named, {
    key: 'assets-bucket',
    kind: 'r2-bucket',
    name: names.assetsBucket,
    matches: r2Buckets.filter((resource) => resource.name === names.assetsBucket),
  });
  addNamedPlan(named, {
    key: 'usage-queue',
    kind: 'queue',
    name: names.usageQueue,
    matches: usageQueues,
  });
  addNamedPlan(named, {
    key: 'cron-queue',
    kind: 'queue',
    name: names.cronQueue,
    matches: cronQueues,
  });
  if (
    options?.deploymentExecution ??
    existing?.resources.some((resource) => resource.key === 'deployment-queue')
  ) {
    addNamedPlan(named, {
      key: 'deployment-queue',
      kind: 'queue',
      name: names.deploymentQueue,
      matches: deploymentQueues,
    });
  }
  addNamedPlan(named, {
    key: 'dispatch-namespace',
    kind: 'dispatch-namespace',
    name: names.dispatchNamespace,
    matches: dispatchNamespaces.filter((resource) => resource.name === names.dispatchNamespace),
  });
  const recordedHyperdrive = existing?.resources.find((resource) => resource.key === 'hyperdrive');
  const externalHyperdriveId =
    input.externalHyperdrive?.id ||
    (recordedHyperdrive?.ownership === 'adopted' ? recordedHyperdrive.id : '');
  if (externalHyperdriveId) {
    if (
      recordedHyperdrive &&
      (recordedHyperdrive.ownership !== 'adopted' || recordedHyperdrive.id !== externalHyperdriveId)
    ) {
      throw new Error(
        'platform: The externally managed Hyperdrive differs from this installation.',
      );
    }
    const remote = hyperdrives.find((resource) => resource.id === externalHyperdriveId);
    const selectedName = input.externalHyperdrive?.name;
    const recordedName = recordedHyperdrive?.name;
    if (
      !remote ||
      (selectedName && remote.name !== selectedName) ||
      (recordedName && remote.name !== recordedName)
    ) {
      throw new Error(
        `platform: Externally managed Hyperdrive ${JSON.stringify(externalHyperdriveId)} must exist with its selected name.`,
      );
    }
    actions.push({
      action: recordedHyperdrive ? 'reuse' : 'adopt',
      id: remote.id,
      key: 'hyperdrive',
      kind: 'hyperdrive',
      name: remote.name,
      reason: recordedHyperdrive
        ? 'Reuse the recorded externally managed Hyperdrive.'
        : 'Use the externally managed Hyperdrive without taking ownership.',
    });
  } else {
    addNamedPlan(named, {
      key: 'hyperdrive',
      kind: 'hyperdrive',
      name: names.hyperdrive,
      matches: hyperdrives.filter((resource) => resource.name === names.hyperdrive),
    });
  }
  for (const [key, name] of [
    ['api-worker', names.apiWorker],
    ['proxy-worker', names.proxyWorker],
    ...(options?.includeEmailGateway === false
      ? []
      : ([['email-gateway-worker', names.emailGatewayWorker]] as const)),
    ['tail-worker', names.tailWorker],
    ['dispatch-worker', names.dispatchWorker],
  ] as const) {
    addNamedPlan(named, {
      key,
      kind: 'worker',
      name,
      matches: workers.includes(name) ? [{ id: name, name }] : [],
      existingAction: 'update',
    });
  }
  const resolvedResources = { ...deployment.resources };
  for (const action of actions) {
    const resourceKey = RESOURCE_NAME_KEY_BY_ACTION[action.key];
    if (resourceKey && action.name !== resolvedResources[resourceKey]) {
      resolvedResources[resourceKey] = action.name;
    }
  }
  const resolvedDeployment = createPlatformDeploymentManifest({
    ...deployment,
    resources: resolvedResources,
  });
  const apiUrl = resolvedDeployment.controlPlane.apiHostname
    ? `https://${deployment.controlPlane.apiHostname}`
    : `https://${resolvedDeployment.resources.apiWorker}.${accountSubdomain}.workers.dev`;
  const proxyUrl = `https://${resolvedDeployment.resources.proxyWorker}.${accountSubdomain}.workers.dev`;
  return {
    account,
    actions,
    apiUrl,
    deployment: resolvedDeployment,
    ...(resolvedDeployment.appAccess
      ? {
          appAccessSetupRequired: !existing?.steps.some(
            (step) => step.key === 'app-access-initialized:v1',
          ),
        }
      : {}),
    ...(input.externalHyperdrive ? { externalHyperdrive: input.externalHyperdrive } : {}),
    installationId,
    proxyUrl,
    workersSubdomain: accountSubdomain,
    zone,
  };
}

export function platformWorkersDevUrl(plan: PlatformInstallPlan, workerName: string): string {
  return `https://${workerName}.${plan.workersSubdomain}.workers.dev`;
}

export async function revalidatePlatformInstallAction(
  client: PlanningClient,
  original: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  options?: {
    authoritativeProvisionIntents?: boolean;
    repairMissing?: boolean;
    stableWorkerUpdate?: boolean;
  },
): Promise<void> {
  // The installed-platform upgrade already planned and verified every shared
  // resource under its lifecycle lock. Recheck the Worker immediately before
  // deployment; deployPlatformWorker independently proves the active version
  // and deployment lineage. Keep full replanning for recovery and provisioning.
  if (
    options?.stableWorkerUpdate &&
    !options.repairMissing &&
    action.kind === 'worker' &&
    action.action === 'update' &&
    original.actions.some(
      (entry) =>
        entry.key === action.key &&
        entry.kind === action.kind &&
        entry.action === action.action &&
        entry.id === action.id &&
        entry.name === action.name,
    ) &&
    original.actions.every((entry) => {
      const resource = manifest.resources.find((candidate) => candidate.key === entry.key);
      return (
        (entry.kind === 'worker' ? entry.action === 'update' : entry.action === 'reuse') &&
        resource?.kind === entry.kind &&
        resource.state === 'ready' &&
        resource.id === entry.id &&
        resource.name === entry.name
      );
    })
  ) {
    const recorded = manifest.resources.find((resource) => resource.key === action.key);
    if (
      !recorded ||
      recorded.kind !== 'worker' ||
      recorded.state !== 'ready' ||
      recorded.id !== action.name ||
      recorded.name !== action.name
    ) {
      throw new Error(
        `platform: Worker ${JSON.stringify(action.name)} no longer matches the approved installation plan. Review a new plan before retrying.`,
      );
    }
    const bindings = await client.getWorkerPlainTextBindings(original.account.id, action.name);
    if (
      resourceMarkerProblem(bindings.PLATFORM_OWNERSHIP_MARKER, manifest, {
        id: action.name,
        key: action.key,
        kind: 'worker',
        name: action.name,
      })
    ) {
      throw new Error(
        `platform: Cloudflare Worker ${JSON.stringify(action.name)} no longer has this installation's ownership marker. Review a new plan before retrying.`,
      );
    }
    return;
  }
  const deployment = original.deployment;
  const refreshed = await createPlatformInstallPlan(
    client,
    {
      accountId: original.account.id,
      applicationDomain: deployment.application.baseDomain,
      controlPlaneDomain: deployment.controlPlane.apiHostname ?? '',
      dedicatedZone: deployment.application.dedicatedZone,
      displayName: deployment.displayName,
      ...(original.externalHyperdrive ? { externalHyperdrive: original.externalHyperdrive } : {}),
      installationSlug: deployment.installationSlug,
      zoneName: deployment.application.zoneName,
    },
    manifest,
    {
      ...options,
      includeEmailGateway: original.actions.some((entry) => entry.key === 'email-gateway-worker'),
      enableSandbox: original.deployment.capabilities.sandbox,
      deploymentExecution: original.actions.some((entry) => entry.key === 'deployment-queue'),
    },
  );
  const current = refreshed.actions.find((entry) => entry.key === action.key);
  if (
    !current ||
    current.kind !== action.kind ||
    current.name !== action.name ||
    current.action !== action.action
  ) {
    throw new Error(
      `platform: Cloudflare changed after the installation plan was approved for ${action.kind} ${JSON.stringify(action.name)}. Review a new plan before retrying.`,
    );
  }
  if (action.kind === 'worker' && action.action === 'update') {
    const bindings = await client.getWorkerPlainTextBindings(original.account.id, action.name);
    if (
      resourceMarkerProblem(bindings.PLATFORM_OWNERSHIP_MARKER, manifest, {
        id: action.name,
        key: action.key,
        kind: 'worker',
        name: action.name,
      })
    ) {
      throw new Error(
        `platform: Cloudflare Worker ${JSON.stringify(action.name)} no longer has this installation's ownership marker. Review a new plan before retrying.`,
      );
    }
  }
}

function resourceSlugForManifest(manifest: PlatformInstallationManifest): string {
  const apiWorker = manifest.deployment.resources.apiWorker;
  if (!apiWorker.startsWith('void-') || !apiWorker.endsWith('-api')) {
    return manifest.deployment.installationSlug;
  }
  const resourceSlug = apiWorker.slice('void-'.length, -'-api'.length);
  const suffix = resourceSlug.slice(resourceSlug.lastIndexOf('-') + 1);
  if (!/^(?:[a-f0-9]{12}|[a-f0-9]{32})$/.test(suffix)) {
    return manifest.deployment.installationSlug;
  }
  return resourceSlug;
}

function addDnsPlan(
  actions: Array<PlatformInstallPlanAction>,
  existing: PlatformInstallationManifest | null,
  name: string,
  records: ReadonlyArray<CloudflareDnsRecord>,
  options?: { authoritativeProvisionIntents?: boolean; repairMissing?: boolean },
): void {
  const compatible = records.filter((record) => record.proxied);
  if (records.some((record) => !record.proxied)) {
    throw new Error(
      `platform: DNS name ${JSON.stringify(name)} contains an unproxied record. Proxy every record at this wildcard name through Cloudflare or choose another application domain.`,
    );
  }
  const recorded = existing?.resources.find((resource) => resource.key === 'application-dns');
  const remote = recorded
    ? compatible.find((record) => record.id === recorded.id)
    : compatible.sort((left, right) => left.id.localeCompare(right.id))[0];
  if (recorded) {
    if (remote && recorded.id === remote.id && recorded.kind === 'dns-record') {
      actions.push({
        action: 'reuse',
        id: remote.id,
        key: 'application-dns',
        kind: 'dns-record',
        name,
        reason: 'Reuse the recorded wildcard application DNS record.',
      });
      return;
    }
    if (!remote && options?.repairMissing && recorded.ownership === 'created') {
      actions.push({
        action: 'create',
        id: null,
        key: 'application-dns',
        kind: 'dns-record',
        name,
        reason: 'Recreate the missing installer-owned wildcard application DNS record.',
      });
      return;
    }
    throw new Error(
      `platform: Recorded DNS record ${JSON.stringify(recorded.name)} (${recorded.id}) no longer matches the Cloudflare zone.`,
    );
  }
  actions.push({
    action: remote ? 'adopt' : 'create',
    id: remote?.id ?? null,
    key: 'application-dns',
    kind: 'dns-record',
    name,
    reason: remote
      ? 'Use the existing compatible wildcard DNS record without taking ownership.'
      : 'Create an installer-owned proxied wildcard DNS record for application traffic.',
  });
}

function resolveAccount(
  accounts: ReadonlyArray<CloudflareAccount>,
  selector: string,
): CloudflareAccount {
  const matches = selector
    ? accounts.filter(
        (account) =>
          account.id === selector || account.name.toLowerCase() === selector.toLowerCase(),
      )
    : accounts;
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `platform: Cloudflare account ${JSON.stringify(selector)} is not available to this token.`
        : 'platform: Select a Cloudflare account with --account <id>.',
    );
  }
  return matches[0]!;
}

type NamedPlanContext = Readonly<{
  actions: Array<PlatformInstallPlanAction>;
  existing: PlatformInstallationManifest | null;
  options?: { authoritativeProvisionIntents?: boolean; repairMissing?: boolean };
  remoteOwnership: PlatformInstallationManifest | null;
  intentProofs: ReadonlySet<string>;
  ambiguousResources: ReadonlySet<string>;
}>;

function addNamedPlan(
  context: NamedPlanContext,
  target: Readonly<{
    key: string;
    kind: InstallationResourceKind;
    name: string;
    matches: ReadonlyArray<CloudflareNamedResource>;
    existingAction?: 'reuse' | 'update';
  }>,
): void {
  const { actions, existing, options, remoteOwnership, intentProofs, ambiguousResources } = context;
  const { key, kind, name, matches, existingAction = 'reuse' } = target;
  if (matches.length > 1) {
    throw new Error(`platform: More than one ${kind} named ${JSON.stringify(name)} exists.`);
  }
  const remote = matches[0];
  const recorded = existing?.resources.find((resource) => resource.key === key);
  if (remote) {
    if (existing && ambiguousResources.has(key)) {
      if (!isLegacyUniqueProvisionAttempt(existing, key, kind, name)) {
        throw new Error(
          `platform: Ownership of ${kind} ${JSON.stringify(name)} could not be verified. The resource was left untouched. Restore this installation's ownership record before resuming, or choose another installation name for a new platform.`,
        );
      }
      actions.push({
        action: 'create',
        id: null,
        key,
        kind,
        name: interruptedProvisionRetryName(existing, key, kind, name),
        reason:
          'Retain the ambiguously owned resource and create a fresh installer-scoped replacement.',
      });
      return;
    }
    const remotelyOwned = remoteOwnership?.resources.some(
      (resource) =>
        resource.key === key &&
        resource.kind === kind &&
        resource.id === remote.id &&
        resource.name === name &&
        resource.ownership === 'created',
    );
    const markedProvision =
      existing !== null &&
      hasUnrecordedProvisionIntent(existing, key, kind, name) &&
      intentProofs.has(key);
    const ambiguousProvision =
      existing !== null &&
      options?.authoritativeProvisionIntents === true &&
      isLegacyUniqueProvisionAttempt(existing, key, kind, name) &&
      hasAmbiguousProvisionIntent(existing, key, kind, remote.id, name);
    if (
      (!recorded || recorded.id !== remote.id || recorded.kind !== kind) &&
      !remotelyOwned &&
      !markedProvision &&
      !ambiguousProvision
    ) {
      // When this installation asked for the resource before it stopped, its
      // failed create may have made it, or someone else may have taken the
      // name. Without a matching marker only the user can tell which.
      throw new Error(
        existing !== null && hasUnrecordedProvisionIntent(existing, key, kind, name)
          ? `platform: ${kind} ${JSON.stringify(name)} already exists, and Void cannot tell whether this installation created it. Nothing was overwritten. If an earlier failed attempt of this installation created it, delete it in the Cloudflare dashboard, then rerun the command. Otherwise, choose another installation name.`
          : `platform: ${kind} ${JSON.stringify(name)} already exists but is not owned by this installation. Resume the owning installation, or choose another installation name. Nothing was overwritten.`,
      );
    }
    if (ambiguousProvision && !markedProvision && !remotelyOwned) {
      actions.push({
        action: 'create',
        id: null,
        key,
        kind,
        name: interruptedProvisionRetryName(existing, key, kind, name),
        reason:
          'Leave the ambiguous same-name resource untouched and create a fresh installer-scoped replacement.',
      });
      return;
    }
    actions.push({
      action: existingAction,
      id: remote.id,
      key,
      kind,
      name,
      reason: markedProvision
        ? 'Recover the resource with its matching ownership marker from an interrupted provisioning attempt.'
        : existingAction === 'update'
          ? 'Deploy the current platform version.'
          : 'Reuse the recorded resource.',
    });
    return;
  }
  if (recorded && recorded.state === 'ready') {
    if (options?.repairMissing && recorded.ownership === 'created') {
      actions.push({
        action: 'create',
        id: null,
        key,
        kind,
        name,
        reason: `Recreate the missing installer-owned ${kind}.`,
      });
      return;
    }
    if (options?.repairMissing && recorded.ownership !== 'created') {
      throw new Error(
        `platform: Recorded ${recorded.ownership} ${kind} ${JSON.stringify(name)} (${recorded.id}) is missing. Repair will not recreate a resource the installer does not own.`,
      );
    }
    throw new Error(
      `platform: Recorded ${kind} ${JSON.stringify(name)} (${recorded.id}) is missing. Run \`void platform repair ${existing!.id}\` to reconcile it.`,
    );
  }
  actions.push({
    action: 'create',
    id: null,
    key,
    kind,
    name,
    reason: `Create an installer-owned ${kind}.`,
  });
}

function hasUnrecordedProvisionIntent(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  name: string,
): boolean {
  return (
    !manifest.resources.some((resource) => resource.key === key && resource.state === 'ready') &&
    hasProvisionIntentStep(manifest, key, kind, name)
  );
}

function hasAmbiguousProvisionIntent(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  remoteId: string,
  name: string,
): boolean {
  const recorded = manifest.resources.find((resource) => resource.key === key);
  if (recorded?.id === remoteId && recorded.kind === kind && recorded.name === name) {
    return false;
  }
  return hasProvisionIntentStep(manifest, key, kind, name, recorded?.id ?? null);
}

/** Whether the manifest records an intent to provision this resource. */
export function hasProvisionIntentStep(
  manifest: Pick<PlatformInstallationManifest, 'ownershipNonce' | 'steps'>,
  key: string,
  kind: InstallationResourceKind,
  name: string,
  previousResourceId: string | null = null,
): boolean {
  return manifest.steps.some(
    (step) =>
      (step.key === `provision-intent:${key}` || step.key.startsWith(`provision-intent:${key}:`)) &&
      step.resultHash ===
        platformProvisionIntentHash(manifest, key, kind, name, previousResourceId),
  );
}

function interruptedProvisionRetryName(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  name: string,
): string {
  const suffix = `-retry-${createHash('sha256')
    .update(JSON.stringify({ key, kind, name, ownershipNonce: manifest.ownershipNonce }))
    .digest('hex')
    .slice(0, 32)}`;
  return `${name.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

// Installation manifests store these config hashes, so their JSON shape must not change.

/** Name-only config hash, recorded for resources without a live fingerprint. */
export function legacyResourceConfigHash(kind: InstallationResourceKind, name: string): string {
  return createHash('sha256').update(JSON.stringify({ kind, name })).digest('hex');
}

export function r2BucketConfigHash(name: string, fingerprint: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ fingerprint, kind: 'r2-bucket', name }))
    .digest('hex');
}

export function dnsRecordConfigHash(
  name: string,
  type: string,
  content: string,
  proxied: boolean,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ content, kind: 'dns-record', name, proxied, type }))
    .digest('hex');
}

/** Whether a live R2 bucket still matches the creation fingerprint recorded for it. */
export function matchesRecordedR2Fingerprint(
  configHash: string,
  bucket: CloudflareNamedResource,
): boolean {
  if (!bucket.fingerprint) {
    return false;
  }
  return (
    configHash === r2BucketConfigHash(bucket.name, bucket.fingerprint) ||
    configHash === legacyResourceConfigHash('r2-bucket', bucket.name)
  );
}

/** Why `value` is not this installation's ownership marker for the resource, or null when it is. */
export function resourceMarkerProblem(
  value: string | null | undefined,
  manifest: PlatformInstallationManifest,
  resource: Pick<InstallationResource, 'id' | 'key' | 'kind' | 'name'>,
): string | null {
  if (!value) {
    return 'has no ownership marker';
  }
  let actual;
  try {
    actual = parsePlatformResourceOwnershipMarker(JSON.parse(value) as unknown);
  } catch {
    return 'has an invalid ownership marker';
  }
  const expected = createPlatformResourceOwnershipMarker({
    accountId: manifest.account.id,
    installationId: manifest.id,
    ownershipNonce: manifest.ownershipNonce,
    resourceId: resource.id,
    resourceKey: resource.key,
    resourceKind: resource.kind,
    resourceName: resource.name,
  });
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? null
    : 'belongs to another installation';
}

// Preserve recovery for previously installed, suffixed namespaces. New platforms
// use readable names and stop on ambiguous ownership instead of renaming resources.
function isLegacyUniqueProvisionAttempt(
  manifest: PlatformInstallationManifest,
  key: string,
  kind: InstallationResourceKind,
  name: string,
): boolean {
  const resourceSlug = resourceSlugForManifest(manifest);
  if (resourceSlug === manifest.deployment.installationSlug) {
    return false;
  }
  const expectedNames = createPlatformResourceNames(resourceSlug);
  const resourceKey = RESOURCE_NAME_KEY_BY_ACTION[key];
  if (!resourceKey) {
    return false;
  }
  const expectedName = expectedNames[resourceKey];
  const uniquePrefix = expectedName.slice(0, expectedName.lastIndexOf('-') + 1);
  return (
    manifest.deployment.resources[resourceKey] === name &&
    (name === expectedName || name.startsWith(uniquePrefix)) &&
    kind !== 'zone' &&
    kind !== 'dns-record'
  );
}

const RESOURCE_NAME_KEY_BY_ACTION: Readonly<
  Record<string, keyof PlatformDeploymentManifest['resources']>
> = {
  'ai-gateway': 'aiGateway',
  'api-worker': 'apiWorker',
  'assets-bucket': 'assetsBucket',
  'cron-queue': 'cronQueue',
  'deployment-queue': 'deploymentQueue',
  'dispatch-namespace': 'dispatchNamespace',
  'dispatch-worker': 'dispatchWorker',
  hyperdrive: 'hyperdrive',
  'isr-cache-kv': 'isrCacheKv',
  'legacy-assets-kv': 'legacyAssetsKv',
  'proxy-worker': 'proxyWorker',
  'email-gateway-worker': 'emailGatewayWorker',
  'routing-kv': 'routingKv',
  'tail-worker': 'tailWorker',
  'usage-queue': 'usageQueue',
};

function assertApplicationRoutesPreserveWorkerDomains(
  patterns: ReadonlyArray<string>,
  dispatchWorker: string,
  ownedDispatchWorker: boolean,
  zoneName: string,
  workerRoutes: ReadonlyArray<CloudflareWorkerRoute>,
  workerDomains: ReadonlyArray<CloudflareWorkerDomain>,
): void {
  const plannedRoutes = patterns.map(parseWorkerRoutePattern);
  const existingRoutes = workerRoutes.map((route) => ({
    ...parseWorkerRoutePattern(route.pattern),
    script: route.script,
  }));
  for (const domain of workerDomains) {
    const hostname = domain.hostname.toLowerCase();
    const inZone = domain.zoneName
      ? domain.zoneName.toLowerCase() === zoneName.toLowerCase()
      : hostname === zoneName.toLowerCase() || hostname.endsWith(`.${zoneName.toLowerCase()}`);
    if (!inZone || (domain.service === dispatchWorker && ownedDispatchWorker)) {
      continue;
    }
    for (const planned of plannedRoutes) {
      if (!workerRouteHostMatches(planned.host, hostname)) {
        continue;
      }
      // Routes run before Custom Domain origins. Only more-specific routes covering every
      // path and both schemes preserve the origin; a no-Worker route is also an exclusion.
      // https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior
      const protectedByExistingRoutes = ['http', 'https'].every((scheme) =>
        existingRoutes.some(
          (route) =>
            route.script !== dispatchWorker &&
            route.path === '/*' &&
            (!route.scheme || route.scheme === scheme) &&
            workerRouteHostMatches(route.host, hostname) &&
            route.host.replace(/^\*/, '').length > planned.host.replace(/^\*/, '').length,
        ),
      );
      if (!protectedByExistingRoutes) {
        throw new Error(
          `platform: Application route ${JSON.stringify(planned.pattern)} would intercept Worker custom domain ${JSON.stringify(domain.hostname)}, currently served by ${JSON.stringify(domain.service)}. Choose another application domain, or use \`void platform install --workers-dev\` for a new installation and add a suitable domain later.`,
        );
      }
    }
  }
}

function parseWorkerRoutePattern(pattern: string): {
  host: string;
  path: string;
  pattern: string;
  scheme: string | null;
} {
  const match = /^(?:(https?):\/\/)?([^/]+)(\/.*)?$/.exec(pattern);
  return {
    host: match?.[2]?.toLowerCase() ?? '',
    path: match?.[3] ?? '/',
    pattern,
    scheme: match?.[1] ?? null,
  };
}

function workerRouteHostMatches(host: string, hostname: string): boolean {
  return host.startsWith('*') ? hostname.endsWith(host.slice(1)) : host === hostname;
}

export function platformProvisionIntentHash(
  manifest: Pick<PlatformInstallationManifest, 'ownershipNonce'>,
  key: string,
  kind: InstallationResourceKind,
  name: string,
  previousResourceId: string | null = null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        key,
        kind,
        name,
        ownershipNonce: manifest.ownershipNonce,
        ...(previousResourceId ? { previousResourceId } : {}),
      }),
    )
    .digest('hex');
}

export function platformAdoptionIntentHash(
  manifest: Pick<PlatformInstallationManifest, 'ownershipNonce'>,
  key: string,
  kind: InstallationResourceKind,
  id: string,
  name: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ id, key, kind, name, ownershipNonce: manifest.ownershipNonce }))
    .digest('hex');
}

async function listZoneDnsRecords(
  client: PlanningClient,
  zone: CloudflareZone,
  hostname: string,
): ReturnType<PlanningClient['listDnsRecords']> {
  try {
    return await client.listDnsRecords(zone.id, hostname);
  } catch (error) {
    if (
      error instanceof PlatformCloudflareApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new Error(
        `platform: Cloudflare denied reading DNS records for ${zone.name} (HTTP ${error.status}). Add Zone → DNS → Edit for this zone to the management token, then rerun.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function readRemoteOwnership(
  client: PlanningClient,
  accountId: string,
  routingNamespaces: ReadonlyArray<CloudflareNamedResource>,
  existing: PlatformInstallationManifest,
): Promise<PlatformInstallationManifest | null> {
  for (const namespace of routingNamespaces) {
    const value = await client.getKvValue(
      accountId,
      namespace.id,
      PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
    );
    if (value === null) {
      continue;
    }
    let remote: PlatformInstallationManifest;
    try {
      remote = parsePlatformInstallationManifest(JSON.parse(value) as unknown);
    } catch {
      throw new Error(
        `platform: Routing namespace ${JSON.stringify(namespace.name)} contains invalid ownership metadata.`,
      );
    }
    const routing = remote.resources.find((resource) => resource.key === 'routing-kv');
    if (
      remote.id === existing.id &&
      remote.ownershipNonce === existing.ownershipNonce &&
      remote.account.id === accountId &&
      routing?.id === namespace.id &&
      routing.name === namespace.name &&
      routing.ownership === 'created'
    ) {
      return remote;
    }
  }
  return null;
}

export function formatPlatformInstallPlan(plan: PlatformInstallPlan): string {
  const lines = [
    `${pc.bold(`${plan.deployment.displayName} in ${plan.account.name}`)}`,
    `${pc.bold('Account:')} ${plan.account.id}`,
    plan.deployment.application.zoneName
      ? `${pc.bold('Applications:')} *.${plan.deployment.application.baseDomain}`
      : `${pc.bold('Applications:')} workers.dev for testing. Add a domain with void platform domain set <domain>`,
    `${pc.bold('Control plane:')} ${plan.apiUrl}`,
    `${pc.bold('Resource proxy:')} ${plan.proxyUrl}`,
    ...(platformDashboardUrl(plan.deployment)
      ? [`${pc.bold('Dashboard:')} ${platformDashboardUrl(plan.deployment)} (deploy separately)`]
      : []),
    `${pc.bold('Login methods:')} ${plan.deployment.authentication.providers.join(', ')}`,
    `${pc.bold('Access protection:')} ${plan.deployment.authentication.accessProtection ? 'Enabled' : 'Not enabled'}`,
    ...(plan.deployment.appAccess
      ? [
          plan.appAccessSetupRequired === false
            ? `${pc.bold('App access:')} Preserve administrator settings`
            : `${pc.bold('Default app access:')} ${{ public: 'Public apps', platform: 'Same as platform Access policy', custom: 'Selected Access policy' }[plan.deployment.appAccess]}`,
        ]
      : []),
    `${pc.bold('Login callback:')} ${plan.apiUrl}/auth/callback`,
    `${pc.bold('Database:')} ${plan.externalHyperdrive?.database || 'PostgreSQL'} via Hyperdrive ${plan.deployment.resources.hyperdrive}`,
    '',
  ];
  for (const action of plan.actions) {
    lines.push(`${action.action.padEnd(6)} ${action.kind.padEnd(19)} ${action.name}`);
  }
  return lines.join('\n');
}
