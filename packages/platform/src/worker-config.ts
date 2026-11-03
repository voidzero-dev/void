import { createPlatformResourceOwnershipMarker } from './installation.ts';
import {
  createApplicationRoutes,
  platformDashboardUrl,
  type PlatformDeploymentManifest,
} from './manifest.ts';

export type PlatformProvisionedResourceIds = Readonly<{
  hyperdrive: string;
  isrCacheKv: string;
  legacyAssetsKv: string;
  routingKv: string;
  zone: string;
}>;

export type PlatformWorkerConfigSet = Readonly<
  Record<'api' | 'dispatch' | 'proxy' | 'tail' | 'emailGateway', Record<string, unknown>>
>;

export function createPlatformWorkerConfigs(input: {
  authenticationDatabaseUncached?: boolean;
  accountId: string;
  apiUrl: string;
  deployment: PlatformDeploymentManifest;
  deploymentExecution?: 1;
  healthProbeToken: string;
  installationId: string;
  ownershipNonce: string;
  platformVersion: string;
  proxyHealthBinding?: boolean;
  publicEndpoints?: boolean;
  privatePreviews?: boolean;
  proxyUrl: string;
  emailGatewayUrl: string;
  resources: PlatformProvisionedResourceIds;
  runtimeEntrypoints: Readonly<
    Record<'api' | 'dispatch' | 'proxy' | 'tail' | 'emailGateway', string>
  >;
  runtimeApiAssetsDirectory?: string;
  trafficState?: 'enabled' | 'sandbox-drain' | 'staging';
}): PlatformWorkerConfigSet {
  const {
    accountId,
    apiUrl,
    deployment,
    healthProbeToken,
    installationId,
    ownershipNonce,
    platformVersion,
    proxyUrl,
    emailGatewayUrl,
    resources,
    runtimeEntrypoints,
  } = input;
  const publicEndpoints = input.publicEndpoints ?? true;
  const trafficState = input.trafficState ?? 'enabled';
  const names = deployment.resources;
  const dashboardUrl = platformDashboardUrl(deployment);
  const sharedEmailIngress = deployment.emailSharedZoneId
    ? {
        EMAIL_SHARED_ACCOUNT_ID: accountId,
        EMAIL_SHARED_ZONE_ID: deployment.emailSharedZoneId,
        EMAIL_SHARED_INGRESS_NAME: names.emailGatewayWorker,
      }
    : {};
  const senderDomain = deployment.emailSenderDomain
    ? { EMAIL_SENDER_DOMAIN: deployment.emailSenderDomain }
    : {};
  const ownershipVars = (resourceKey: string, resourceName: string) => ({
    PLATFORM_OWNERSHIP_MARKER: JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId,
        installationId,
        ownershipNonce,
        resourceId: resourceName,
        resourceKey,
        resourceKind: 'worker',
        resourceName,
      }),
    ),
  });
  // Sent only in minimal mode, so default Worker configs stay unchanged.
  const runtimeLogs = deployment.runtimeLogs
    ? { PLATFORM_RUNTIME_LOGS: deployment.runtimeLogs }
    : {};
  const common = {
    account_id: accountId,
    compatibility_date: '2026-02-24',
    // Minimal runtime logs keep Workers Logs off on every platform Worker.
    observability: { enabled: !deployment.runtimeLogs },
    preview_urls: publicEndpoints && !deployment.authentication.accessProtection,
    workers_dev: publicEndpoints,
  };
  const kv = [
    { binding: 'ROUTING', id: resources.routingKv },
    { binding: 'ISR_CACHE', id: resources.isrCacheKv },
    { binding: 'STATIC_ASSETS', id: resources.legacyAssetsKv },
  ];
  const dispatchNamespace = [{ binding: 'DISPATCH', namespace: names.dispatchNamespace }];
  const r2 = [{ binding: 'STATIC_ASSETS_R2', bucket_name: names.assetsBucket }];
  // Installer probes must re-enter the public edge. The optional API-to-proxy
  // health binding is attached only at final cutover, after the proxy exists.
  const fetchWorkersDev =
    Boolean(deployment.application.workersDev) ||
    [apiUrl, proxyUrl, ...(deployment.capabilities.email ? [emailGatewayUrl] : [])].some((url) =>
      new URL(url).hostname.endsWith('.workers.dev'),
    );

  const api: Record<string, unknown> = {
    ...common,
    ...((input.privatePreviews || input.proxyHealthBinding) &&
    publicEndpoints &&
    trafficState === 'enabled'
      ? {
          services: [
            ...(input.privatePreviews
              ? [
                  {
                    binding: 'PREVIEW_DISPATCH',
                    service: names.dispatchWorker,
                    entrypoint: 'PreviewDispatcher',
                  },
                ]
              : []),
            ...(input.proxyHealthBinding
              ? [{ binding: 'PLATFORM_PROXY', service: names.proxyWorker }]
              : []),
          ],
        }
      : {}),
    version_metadata: { binding: 'VERSION_METADATA' },
    workers_dev:
      publicEndpoints &&
      (!deployment.authentication.accessProtection ||
        new URL(apiUrl).hostname.endsWith('.workers.dev')),
    name: names.apiWorker,
    main: runtimeEntrypoints.api,
    no_bundle: true,
    ...(input.runtimeApiAssetsDirectory
      ? { assets: { directory: input.runtimeApiAssetsDirectory } }
      : {}),
    compatibility_flags: [
      'nodejs_compat',
      ...(fetchWorkersDev ? ['global_fetch_strictly_public'] : []),
    ],
    placement: { mode: 'smart' },
    hyperdrive: [{ binding: 'HYPERDRIVE', id: resources.hyperdrive }],
    kv_namespaces: kv,
    ...(deployment.capabilities.email ? { send_email: [{ name: 'EMAIL' }] } : {}),
    r2_buckets: r2,
    dispatch_namespaces: dispatchNamespace,
    durable_objects: {
      bindings: [
        { name: 'USAGE_COUNTER', class_name: 'UsageCounter' },
        { name: 'CRON_SCHEDULER', class_name: 'CronScheduler' },
        { name: 'ERROR_ALERT_MONITOR', class_name: 'ErrorAlertMonitor' },
        { name: 'SANDBOX_CONCURRENCY_COUNTER', class_name: 'SandboxConcurrencyCounter' },
      ],
    },
    migrations: [
      { tag: 'v1', new_sqlite_classes: ['UsageCounter'] },
      { tag: 'v2', new_sqlite_classes: ['CronScheduler'] },
      { tag: 'v3', new_sqlite_classes: ['ErrorAlertMonitor'] },
      { tag: 'v4', new_sqlite_classes: ['SandboxConcurrencyCounter'] },
    ],
    queues: {
      producers: [
        { binding: 'CRON_FIRES_QUEUE', queue: names.cronQueue },
        { binding: 'USAGE_EVENTS_QUEUE', queue: names.usageQueue },
        ...(input.deploymentExecution === 1
          ? [{ binding: 'DEPLOYMENTS_QUEUE', queue: names.deploymentQueue }]
          : []),
      ],
      consumers: [
        { queue: names.usageQueue, max_batch_size: 100, max_batch_timeout: 5 },
        { queue: names.cronQueue, max_batch_size: 50, max_batch_timeout: 1, max_retries: 3 },
        ...(input.deploymentExecution === 1
          ? [
              {
                queue: names.deploymentQueue,
                max_batch_size: 1,
                max_batch_timeout: 1,
                max_retries: 100,
                retry_delay: 60,
              },
            ]
          : []),
      ],
    },
    triggers: {
      crons: ['0 * * * *', ...(input.deploymentExecution === 1 ? ['*/2 * * * *'] : [])],
    },
    vars: {
      AUTH_REDIRECT_URI: `${apiUrl}/auth/callback`,
      ...(dashboardUrl ? { DASHBOARD_URL: dashboardUrl } : {}),
      AI_GATEWAY_ID: names.aiGateway,
      CRON_FIRES_QUEUE_NAME: names.cronQueue,
      ...(input.deploymentExecution === 1 ? { DEPLOYMENTS_QUEUE_NAME: names.deploymentQueue } : {}),
      DISPATCH_NAMESPACE: names.dispatchNamespace,
      DISPATCH_WORKER_NAME: names.dispatchWorker,
      LOGS_DATASET: names.logsDataset,
      PLATFORM_CAPABILITIES: JSON.stringify(deployment.capabilities),
      ...(input.authenticationDatabaseUncached ? { PLATFORM_AUTH_DATABASE_UNCACHED: 'true' } : {}),
      PLATFORM_DISPLAY_NAME: deployment.displayName,
      PLATFORM_ENV: 'production',
      PLATFORM_HEALTH_PROBE_TOKEN: healthProbeToken,
      ...(deployment.appAccess ? { PLATFORM_APP_ACCESS: deployment.appAccess } : {}),
      PLATFORM_INSTALLATION_ID: installationId,
      ...runtimeLogs,
      PLATFORM_TRAFFIC_STATE: trafficState,
      ...ownershipVars('api-worker', names.apiWorker),
      PLATFORM_VERSION: platformVersion,
      PROXY_URL: proxyUrl,
      EMAIL_GATEWAY_ORIGIN: emailGatewayUrl,
      ...sharedEmailIngress,
      ...senderDomain,
      R2_STATIC_ASSETS_BUCKET: names.assetsBucket,
      REQUESTS_DATASET: names.requestsDataset,
      SITE_DOMAIN: deployment.application.baseDomain,
      ...(deployment.application.workersDev
        ? { PLATFORM_APPLICATION: JSON.stringify(deployment.application) }
        : {}),
      TAIL_SERVICE_NAME: names.tailWorker,
      VOID_PROXY_SERVICE: names.proxyWorker,
      SANDBOX_CONTROL_SERVICE: names.apiWorker,
    },
  };
  if (publicEndpoints && deployment.controlPlane.apiHostname) {
    api.routes = [{ pattern: deployment.controlPlane.apiHostname, custom_domain: true }];
  }

  const proxy: Record<string, unknown> = {
    ...common,
    workers_dev:
      publicEndpoints &&
      (!deployment.authentication.accessProtection ||
        new URL(proxyUrl).hostname.endsWith('.workers.dev')),
    name: names.proxyWorker,
    main: runtimeEntrypoints.proxy,
    no_bundle: true,
    compatibility_flags: ['nodejs_compat'],
    ai: { binding: 'AI' },
    kv_namespaces: [{ binding: 'ROUTING', id: resources.routingKv }],
    services: [{ binding: 'API', service: names.apiWorker }],
    dispatch_namespaces: dispatchNamespace,
    ...(deployment.capabilities.email ? { send_email: [{ name: 'SEND_EMAIL' }] } : {}),
    vars: {
      AI_GATEWAY_ID: names.aiGateway,
      PLATFORM_CAPABILITIES: JSON.stringify(deployment.capabilities),
      PLATFORM_HEALTH_PROBE_TOKEN: healthProbeToken,
      PLATFORM_INSTALLATION_ID: installationId,
      PLATFORM_TRAFFIC_STATE: trafficState,
      ...senderDomain,
      ...ownershipVars('proxy-worker', names.proxyWorker),
    },
  };
  if (publicEndpoints && deployment.controlPlane.proxyHostname) {
    proxy.routes = [{ pattern: deployment.controlPlane.proxyHostname, custom_domain: true }];
  }

  return {
    api,
    proxy,
    emailGateway: {
      ...common,
      preview_urls: false,
      name: names.emailGatewayWorker,
      main: runtimeEntrypoints.emailGateway,
      no_bundle: true,
      compatibility_flags: ['nodejs_compat'],
      kv_namespaces: [{ binding: 'ROUTING', id: resources.routingKv }],
      services: [{ binding: 'API', service: names.apiWorker }],
      dispatch_namespaces: dispatchNamespace,
      ...(deployment.capabilities.email ? { send_email: [{ name: 'SEND_EMAIL' }] } : {}),
      vars: {
        PLATFORM_CAPABILITIES: JSON.stringify(deployment.capabilities),
        PLATFORM_INSTALLATION_ID: installationId,
        PLATFORM_VERSION: platformVersion,
        PLATFORM_TRAFFIC_STATE: trafficState,
        ...sharedEmailIngress,
        ...senderDomain,
        ...ownershipVars('email-gateway-worker', names.emailGatewayWorker),
      },
    },
    tail: {
      ...common,
      // The tail worker only receives trace events from the dispatch worker.
      workers_dev: false,
      preview_urls: false,
      name: names.tailWorker,
      main: runtimeEntrypoints.tail,
      no_bundle: true,
      analytics_engine_datasets: [{ binding: 'ANALYTICS', dataset: names.logsDataset }],
      vars: {
        PLATFORM_DISPATCH_WORKER_NAME: names.dispatchWorker,
        ...runtimeLogs,
        ...ownershipVars('tail-worker', names.tailWorker),
      },
    },
    dispatch: {
      ...common,
      ...(input.privatePreviews
        ? { services: [{ binding: 'PREVIEW_API', service: names.apiWorker }] }
        : {}),
      name: names.dispatchWorker,
      main: runtimeEntrypoints.dispatch,
      no_bundle: true,
      ...(publicEndpoints
        ? {
            routes: createApplicationRoutes(deployment.application).map((route) => ({
              pattern: route.pattern,
              zone_name: route.zoneName,
            })),
          }
        : {}),
      dispatch_namespaces: dispatchNamespace,
      kv_namespaces: kv,
      r2_buckets: r2,
      analytics_engine_datasets: [
        { binding: 'ANALYTICS', dataset: names.requestsDataset },
        { binding: 'LOGS', dataset: names.logsDataset },
      ],
      queues: { producers: [{ binding: 'USAGE_QUEUE', queue: names.usageQueue }] },
      tail_consumers: [{ service: names.tailWorker }],
      vars: {
        BASE_HOSTNAME: deployment.application.baseDomain,
        ...(deployment.application.workersDev
          ? { PLATFORM_APPLICATION: JSON.stringify(deployment.application) }
          : {}),
        PLATFORM_HEALTH_PROBE_TOKEN: healthProbeToken,
        PLATFORM_INSTALLATION_ID: installationId,
        PLATFORM_TRAFFIC_STATE: trafficState,
        ...runtimeLogs,
        ...ownershipVars('dispatch-worker', names.dispatchWorker),
      },
    },
  };
}
