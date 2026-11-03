import type { PlatformApplication } from './application.ts';
import { PLATFORM_LOGIN_KINDS, type PlatformLoginKind } from './authentication.ts';
import { assertRecord, requiredString } from './validate.ts';

export const PLATFORM_DEPLOYMENT_SCHEMA_VERSION = 1 as const;

export type PlatformCapabilities = Readonly<{
  ai: boolean;
  customDomains: boolean;
  email: boolean;
  githubActions: boolean;
  githubOAuth: boolean;
  googleOAuth: boolean;
  managedBuilds: boolean;
  sandbox: boolean;
}>;

export type PlatformControlPlane = Readonly<{
  apiHostname: string | null;
  dashboardHostname: string | null;
  /** Optional separately deployed dashboard origin, including its HTTPS port. */
  dashboardUrl?: string;
  proxyHostname: string | null;
}>;

export type PlatformResourceNames = Readonly<{
  aiGateway: string;
  apiWorker: string;
  assetsBucket: string;
  cronQueue: string;
  deploymentQueue: string;
  dashboardWorker: string;
  dispatchNamespace: string;
  dispatchWorker: string;
  emailGatewayWorker: string;
  hyperdrive: string;
  isrCacheKv: string;
  legacyAssetsKv: string;
  logsDataset: string;
  proxyWorker: string;
  requestsDataset: string;
  routingKv: string;
  tailWorker: string;
  usageQueue: string;
}>;

export type PlatformAppAccess = 'public' | 'platform' | 'custom';

/**
 * `minimal` keeps request URLs, console messages and exception messages out of
 * Workers Logs and the platform's request log rows. Omitted means `full`.
 */
export type PlatformRuntimeLogs = 'minimal';

export type PlatformDeploymentManifest = Readonly<{
  /** Initial app-access choice. Omitted on installations created before guided setup. */
  appAccess?: PlatformAppAccess;
  application: PlatformApplication;
  /** Zone that owns the installation's shared sender mail domain. */
  emailSharedZoneId?: string;
  /** Shared sender domain registered for managed email. */
  emailSenderDomain?: string;
  authentication: Readonly<{
    providers: ReadonlyArray<PlatformLoginKind>;
    configurable?: true;
    accessProtection?: true;
  }>;
  capabilities: PlatformCapabilities;
  controlPlane: PlatformControlPlane;
  displayName: string;
  installationSlug: string;
  resources: PlatformResourceNames;
  /** Requires schema version 5, so an older CLI refuses the manifest instead of dropping it. */
  runtimeLogs?: PlatformRuntimeLogs;
  schemaVersion: typeof PLATFORM_DEPLOYMENT_SCHEMA_VERSION | 2 | 3 | 4 | 5;
}>;

export type PlatformDeploymentManifestInput = Readonly<{
  appAccess?: PlatformAppAccess;
  application: Readonly<{
    baseDomain: string;
    dedicatedZone?: boolean;
    zoneName: string;
    workersDev?: PlatformApplication['workersDev'];
    zoneId?: string;
  }>;
  emailSharedZoneId?: string;
  emailSenderDomain?: string;
  authentication?: Readonly<{
    providers?: ReadonlyArray<PlatformLoginKind>;
    configurable?: true;
    accessProtection?: true;
  }>;
  capabilities?: Partial<PlatformCapabilities>;
  controlPlane?: Partial<PlatformControlPlane>;
  displayName: string;
  installationSlug: string;
  resources?: Partial<PlatformResourceNames>;
  runtimeLogs?: PlatformRuntimeLogs;
}>;

export type PlatformApplicationRoute = Readonly<{
  pattern: string;
  zoneName: string;
}>;

const CORE_CAPABILITIES: PlatformCapabilities = {
  ai: true,
  customDomains: false,
  email: false,
  githubActions: false,
  githubOAuth: true,
  googleOAuth: false,
  managedBuilds: false,
  sandbox: false,
};

const CONTROL_PLANE_DEFAULTS: PlatformControlPlane = {
  apiHostname: null,
  dashboardHostname: null,
  proxyHostname: null,
};

export function normalizeInstallationSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll(/-{2,}/g, '-');
  if (!slug) {
    throw new Error('The installation name must contain a letter or number.');
  }
  if (slug.length > 40) {
    throw new Error('The installation name must be 40 characters or fewer after normalization.');
  }
  return slug;
}

export function normalizeApplicationDomain(value: string): string {
  let domain = value.trim().toLowerCase();
  if (domain.endsWith('.')) {
    domain = domain.slice(0, -1);
  }
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`Invalid domain: ${JSON.stringify(value)}.`);
  }
  return domain;
}

export function normalizePlatformDashboardUrl(value: string): string {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('The dashboard URL must be an HTTPS origin.');
  }
  if (
    !/^https:\/\/[^/?#]+\/?$/i.test(text) ||
    /[\s\\]/.test(text) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'The dashboard URL must be an HTTPS origin without credentials, a path, query, or fragment.',
    );
  }
  url.hostname = normalizeApplicationDomain(url.hostname);
  return url.origin;
}

export function platformDashboardUrl(deployment: PlatformDeploymentManifest): string | null {
  const url =
    deployment.controlPlane.dashboardUrl ??
    (deployment.controlPlane.dashboardHostname
      ? `https://${deployment.controlPlane.dashboardHostname}`
      : null);
  return url === null ? null : normalizePlatformDashboardUrl(url);
}

export function createPlatformResourceNames(installationSlug: string): PlatformResourceNames {
  const slug = normalizeInstallationSlug(installationSlug);
  const prefix = `void-${slug}`;
  const datasetPrefix = prefix.replaceAll('-', '_');
  return {
    aiGateway: prefix,
    apiWorker: `${prefix}-api`,
    assetsBucket: `${prefix}-assets`,
    cronQueue: `${prefix}-cron-fires`,
    deploymentQueue: `${prefix}-deployments`,
    dashboardWorker: `${prefix}-dashboard`,
    dispatchNamespace: `${prefix}-users`,
    dispatchWorker: `${prefix}-dispatch`,
    emailGatewayWorker: `${prefix}-email-gateway`,
    hyperdrive: `${prefix}-database`,
    isrCacheKv: `${prefix}-isr-cache`,
    legacyAssetsKv: `${prefix}-legacy-assets`,
    logsDataset: `${datasetPrefix}_logs`,
    proxyWorker: `${prefix}-proxy`,
    requestsDataset: `${datasetPrefix}_requests`,
    routingKv: `${prefix}-routing`,
    tailWorker: `${prefix}-tail`,
    usageQueue: `${prefix}-usage-events`,
  };
}

export function createApplicationRoutes(
  application: PlatformDeploymentManifest['application'],
): ReadonlyArray<PlatformApplicationRoute> {
  if (!application.zoneName && application.workersDev) {
    if (application.dedicatedZone) {
      throw new Error('workers.dev cannot use a dedicated-zone catch-all.');
    }
    return [];
  }
  const baseDomain = normalizeApplicationDomain(application.baseDomain);
  const zoneName = normalizeApplicationDomain(application.zoneName);
  if (baseDomain !== zoneName && !baseDomain.endsWith(`.${zoneName}`)) {
    throw new Error(`Application domain ${baseDomain} is not inside zone ${zoneName}.`);
  }
  const routes: Array<PlatformApplicationRoute> = [
    { pattern: `*.${baseDomain}/*`, zoneName },
    { pattern: `*.${baseDomain}`, zoneName },
  ];
  if (application.dedicatedZone) {
    if (baseDomain !== zoneName) {
      throw new Error('A dedicated-zone catch-all requires the application domain to be the zone.');
    }
    routes.push({ pattern: '*/*', zoneName }, { pattern: '*', zoneName });
  }
  return routes;
}

export function createPlatformDeploymentManifest(
  input: PlatformDeploymentManifestInput,
): PlatformDeploymentManifest {
  if ((input.emailSharedZoneId === undefined) !== (input.emailSenderDomain === undefined)) {
    throw new Error(
      'Shared email configuration requires both emailSenderDomain and emailSharedZoneId.',
    );
  }
  const installationSlug = normalizeInstallationSlug(input.installationSlug);
  const baseDomain = normalizeApplicationDomain(input.application.baseDomain);
  const workersDev = input.application.workersDev;
  if (
    workersDev &&
    (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workersDev.subdomain) ||
      !/^[a-z0-9][a-z0-9-]{0,80}$/.test(workersDev.installationId))
  ) {
    throw new Error('Invalid workers.dev installation identity.');
  }
  const zoneName =
    workersDev && input.application.zoneName === ''
      ? ''
      : normalizeApplicationDomain(input.application.zoneName);
  if (!zoneName && baseDomain !== `${workersDev!.subdomain}.workers.dev`) {
    throw new Error('workers.dev application domain must match its account subdomain.');
  }
  const resources = { ...createPlatformResourceNames(installationSlug), ...input.resources };
  const capabilities = { ...CORE_CAPABILITIES, ...input.capabilities };
  if (capabilities.managedBuilds && !capabilities.githubActions) {
    throw new Error('Managed builds require the GitHub Actions capability.');
  }
  if (
    input.appAccess !== undefined &&
    !['public', 'platform', 'custom'].includes(input.appAccess)
  ) {
    throw new Error('appAccess must be public, platform, or custom.');
  }
  if (input.runtimeLogs !== undefined && input.runtimeLogs !== 'minimal') {
    throw new Error('runtimeLogs must be minimal when set.');
  }
  const providers = input.authentication?.providers ?? ['github'];
  if (
    providers.some((provider) => !PLATFORM_LOGIN_KINDS.includes(provider)) ||
    new Set(providers).size !== providers.length
  ) {
    throw new Error('Authentication providers must be unique supported login kinds.');
  }
  const configurable =
    input.authentication?.configurable === true ||
    input.authentication?.accessProtection === true ||
    providers.some((provider) => provider === 'oidc' || provider === 'cloudflare-access');
  if (providers.length === 0) {
    throw new Error('At least one authentication provider is required.');
  }
  if (providers.includes('github') !== capabilities.githubOAuth) {
    throw new Error('The GitHub provider and githubOAuth capability must agree.');
  }
  if (providers.includes('google') !== capabilities.googleOAuth) {
    throw new Error('The Google provider and googleOAuth capability must agree.');
  }
  const dashboardUrl =
    input.controlPlane?.dashboardUrl === undefined
      ? undefined
      : normalizePlatformDashboardUrl(input.controlPlane.dashboardUrl);
  const manifest: PlatformDeploymentManifest = {
    ...(input.appAccess !== undefined ? { appAccess: input.appAccess } : {}),
    application: {
      baseDomain,
      dedicatedZone: input.application.dedicatedZone ?? false,
      zoneName,
      ...(workersDev ? { workersDev: { ...workersDev } } : {}),
      ...(input.application.zoneId
        ? { zoneId: requiredString(input.application.zoneId, 'application.zoneId') }
        : {}),
    },
    authentication: {
      providers: [...providers],
      ...(configurable ? { configurable: true } : {}),
      ...(input.authentication?.accessProtection ? { accessProtection: true } : {}),
    },
    capabilities,
    ...(input.emailSharedZoneId !== undefined
      ? { emailSharedZoneId: requiredString(input.emailSharedZoneId, 'emailSharedZoneId') }
      : {}),
    ...(input.emailSenderDomain !== undefined
      ? { emailSenderDomain: normalizeApplicationDomain(input.emailSenderDomain) }
      : {}),
    controlPlane: {
      ...CONTROL_PLANE_DEFAULTS,
      ...input.controlPlane,
      ...(dashboardUrl !== undefined
        ? {
            dashboardUrl,
            dashboardHostname:
              input.controlPlane?.dashboardHostname ?? new URL(dashboardUrl).hostname,
          }
        : {}),
    },
    displayName: requiredString(input.displayName, 'displayName').trim(),
    installationSlug,
    resources,
    ...(input.runtimeLogs ? { runtimeLogs: input.runtimeLogs } : {}),
    schemaVersion: input.runtimeLogs
      ? 5
      : input.appAccess !== undefined
        ? 4
        : configurable
          ? 3
          : workersDev
            ? 2
            : PLATFORM_DEPLOYMENT_SCHEMA_VERSION,
  };
  createApplicationRoutes(manifest.application);
  for (const [key, value] of Object.entries(manifest.controlPlane)) {
    if (key === 'dashboardUrl') {
      continue;
    }
    if (value !== null) {
      normalizeApplicationDomain(value);
    }
  }
  if (manifest.controlPlane.dashboardUrl) {
    const hostname = new URL(manifest.controlPlane.dashboardUrl).hostname;
    if (manifest.controlPlane.dashboardHostname !== hostname) {
      throw new Error('The dashboard URL and dashboard hostname must agree.');
    }
  }
  for (const [key, value] of Object.entries(manifest.resources)) {
    requiredString(value, `resources.${key}`);
  }
  return manifest;
}

export function parsePlatformDeploymentManifest(value: unknown): PlatformDeploymentManifest {
  assertRecord(value, 'Platform deployment manifest');
  if (
    value.schemaVersion !== PLATFORM_DEPLOYMENT_SCHEMA_VERSION &&
    value.schemaVersion !== 2 &&
    value.schemaVersion !== 3 &&
    value.schemaVersion !== 4 &&
    value.schemaVersion !== 5
  ) {
    throw new Error(
      `Unsupported platform deployment schema version: ${String(value.schemaVersion)}.`,
    );
  }
  const application = value.application;
  const authentication = value.authentication;
  const rawCapabilities = value.capabilities;
  const controlPlane = value.controlPlane;
  const rawResources = value.resources;
  assertRecord(application, 'application');
  let workersDev: PlatformApplication['workersDev'];
  if (
    value.schemaVersion === 2 ||
    (Number(value.schemaVersion) >= 3 && application.workersDev !== undefined)
  ) {
    assertRecord(application.workersDev, 'application.workersDev');
    workersDev = {
      subdomain: requiredString(application.workersDev.subdomain, 'workersDev.subdomain'),
      installationId: requiredString(
        application.workersDev.installationId,
        'workersDev.installationId',
      ),
    };
  } else if (application.workersDev !== undefined) {
    throw new Error('workers.dev requires platform deployment schema version 2.');
  }
  assertRecord(rawCapabilities, 'capabilities');
  assertRecord(controlPlane, 'controlPlane');
  assertRecord(authentication, 'authentication');
  assertRecord(rawResources, 'resources');
  const capabilityKeys = Object.keys(CORE_CAPABILITIES) as Array<keyof PlatformCapabilities>;
  const capabilities: Partial<Record<keyof PlatformCapabilities, boolean>> = {};
  for (const key of capabilityKeys) {
    const entry = rawCapabilities[key];
    if (typeof entry !== 'boolean') {
      throw new Error(`capabilities.${key} must be a boolean.`);
    }
    capabilities[key] = entry;
  }
  const providers = authentication.providers;
  if (
    !Array.isArray(providers) ||
    providers.some(
      (provider) =>
        !PLATFORM_LOGIN_KINDS.includes(provider as PlatformLoginKind) ||
        (Number(value.schemaVersion) < 3 && provider !== 'github' && provider !== 'google'),
    )
  ) {
    throw new Error('authentication.providers must contain only github or google.');
  }
  if (
    (value.schemaVersion === 3 && authentication.configurable !== true) ||
    (Number(value.schemaVersion) < 3 &&
      (authentication.configurable !== undefined ||
        authentication.accessProtection !== undefined)) ||
    (authentication.accessProtection !== undefined && authentication.accessProtection !== true)
  ) {
    throw new Error('Configurable authentication requires deployment schema version 3.');
  }
  if (
    value.schemaVersion === 4
      ? !['public', 'platform', 'custom'].includes(String(value.appAccess))
      : value.schemaVersion === 5
        ? value.appAccess !== undefined &&
          !['public', 'platform', 'custom'].includes(String(value.appAccess))
        : value.appAccess !== undefined
  ) {
    throw new Error(
      'Guided app access requires deployment schema version 4 and a valid appAccess choice.',
    );
  }
  if (authentication.configurable !== undefined && authentication.configurable !== true) {
    throw new Error('Invalid configurable authentication flag.');
  }
  if (
    value.schemaVersion === 5 ? value.runtimeLogs !== 'minimal' : value.runtimeLogs !== undefined
  ) {
    throw new Error('Minimal runtime logs require deployment schema version 5.');
  }
  const resourceDefaults = createPlatformResourceNames(
    requiredString(value.installationSlug, 'installationSlug'),
  );
  const resources: Partial<Record<keyof PlatformResourceNames, string>> = {};
  for (const key of Object.keys(resourceDefaults) as Array<keyof PlatformResourceNames>) {
    resources[key] = requiredString(
      rawResources[key] ??
        (key === 'emailGatewayWorker' || key === 'deploymentQueue'
          ? resourceDefaults[key]
          : undefined),
      `resources.${key}`,
    );
  }
  const readHostname = (
    key: 'apiHostname' | 'dashboardHostname' | 'proxyHostname',
  ): string | null => {
    const hostname = controlPlane[key];
    return hostname === null ? null : requiredString(hostname, `controlPlane.${key}`);
  };
  return createPlatformDeploymentManifest({
    ...(Number(value.schemaVersion) >= 4 && value.appAccess !== undefined
      ? { appAccess: value.appAccess as PlatformAppAccess }
      : {}),
    application: {
      baseDomain: requiredString(application.baseDomain, 'application.baseDomain'),
      dedicatedZone: application.dedicatedZone === true,
      zoneName:
        workersDev && application.zoneName === ''
          ? ''
          : requiredString(application.zoneName, 'application.zoneName'),
      ...(workersDev ? { workersDev } : {}),
      ...(typeof application.zoneId === 'string' ? { zoneId: application.zoneId } : {}),
    },
    authentication: {
      providers: providers as Array<PlatformLoginKind>,
      ...(authentication.configurable === true ? { configurable: true } : {}),
      ...(authentication.accessProtection === true ? { accessProtection: true } : {}),
    },
    capabilities,
    ...(value.emailSharedZoneId !== undefined
      ? { emailSharedZoneId: requiredString(value.emailSharedZoneId, 'emailSharedZoneId') }
      : {}),
    ...(value.emailSenderDomain !== undefined
      ? { emailSenderDomain: requiredString(value.emailSenderDomain, 'emailSenderDomain') }
      : {}),
    controlPlane: {
      apiHostname: readHostname('apiHostname'),
      dashboardHostname: readHostname('dashboardHostname'),
      ...(controlPlane.dashboardUrl !== undefined
        ? { dashboardUrl: requiredString(controlPlane.dashboardUrl, 'controlPlane.dashboardUrl') }
        : {}),
      proxyHostname: readHostname('proxyHostname'),
    },
    displayName: requiredString(value.displayName, 'displayName'),
    installationSlug: requiredString(value.installationSlug, 'installationSlug'),
    resources,
    ...(value.schemaVersion === 5 ? { runtimeLogs: 'minimal' as const } : {}),
  });
}
