import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { encodeCloudflareVersionMessage } from '@void/deploy-cloudflare';
import {
  createApplicationRoutes,
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  parsePlatformInstallationManifest,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  PLATFORM_SANDBOX_DRAIN_KEY,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationDesiredState,
  transitionInstallation,
} from '@void/platform';
import {
  getPlatformRuntimeDirectory,
  platformDatabaseSchemaDigest,
  readPlatformRuntimeManifest,
  resolvePlatformRuntime,
  type PlatformRuntimeDatabaseManifest,
} from '@void/platform/installer';
import { toSlash } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformCloudflareApiError } from '../../src/cli/platform-cloudflare.ts';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
  PlatformCloudflareClient,
} from '../../src/cli/platform-cloudflare.ts';
import {
  resolvePlatformPreviousTriggerConfig,
  stablePublicEndpointState,
  withoutCompletedPlatformWorkerMigrations,
} from '../../src/cli/platform-installer-cutover.ts';
import {
  acquirePlatformDatabaseLifecycleLockConnection,
  inspectPlatformDatabaseStateConnection,
  preparePlatformDatabaseConnection,
  preparePlatformSandboxDrainConnection,
  readPlatformDatabaseLifecycleManifestConnection,
} from '../../src/cli/platform-installer-database.ts';
import {
  bootstrapPlatformSharedEmail,
  verifyPlatformHealth,
  verifyPlatformSandboxDrain,
} from '../../src/cli/platform-installer-health.ts';
import {
  classifyPlatformWorkerDeploymentLineage,
  inspectNewPlatformWorker,
  readActivePlatformWorkerSnapshot,
  readPlatformWorkerDeployments,
} from '../../src/cli/platform-installer-inspection.ts';
import { withConditionalPlatformWorkerCreate } from '../../src/cli/platform-installer-process.ts';
import {
  inventoryUnmanagedPlatformWorkerTraffic,
  isolatePlatformWorkerCustomDomains,
  mergePlatformWorkerTrafficConfig,
  mergePreservedTriggerRoutes,
  retainReplacedInstallationResource,
  withoutPlatformWorkerTrafficAttachments,
} from '../../src/cli/platform-installer-resources.ts';
import {
  apiWorkerSecrets,
  assertRequiredPlatformSecrets,
  createPlatformHealthProbeToken,
  createPlatformInstallationSecrets,
  platformWorkerSecretPayload,
  resolveBootstrapGitHubId,
} from '../../src/cli/platform-installer-secrets.ts';
import {
  mergePlatformLiveAuthenticationDeployment,
  PlatformWorkerRecoveryIncompleteError,
} from '../../src/cli/platform-installer-types.ts';
import {
  platformWorkerUploadFingerprint,
  recoverFailedPlatformWorkerDeployment,
  restorePlatformWorkerDeployment,
} from '../../src/cli/platform-installer-workers.ts';
import { installPlatform as installPlatformImplementation } from '../../src/cli/platform-installer.ts';
import { resolvePlatformInstallDatabaseUrl } from '../../src/cli/platform-lifecycle.ts';
import {
  createPlatformInstallPlan,
  platformProvisionIntentHash,
  r2BucketConfigHash,
} from '../../src/cli/platform-plan.ts';
import {
  listInstallationManifests,
  promoteInstallationSecrets,
  readInstallationRecoverySecrets,
  readPendingInstallationSecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from '../../src/cli/platform-registry.ts';
import {
  completePlatformSetupDraft,
  savePlatformSetupDraft,
} from '../../src/cli/platform-setup-draft.ts';
import { resolvePinnedApiBaseUrl } from '../../src/cli/provision.ts';

const directories: Array<string> = [];
type InstallArguments = Parameters<typeof installPlatformImplementation>;
type InstallClient = InstallArguments[3]['client'];
type DefaultedClientMethods =
  | 'apiBaseUrl'
  | 'deleteKvValue'
  | 'disableHyperdriveCaching'
  | 'getHyperdriveConfig'
  | 'getWorkerPlainTextBindings'
  | 'listWorkerDomains'
  | 'listWorkerNames'
  | 'listWorkerRoutes'
  | 'listWorkerServiceRoutes'
  | 'publishWorkerCustomDomainsSafely'
  | 'publishWorkerRoutesSafely'
  | 'request';
type TestInstallerDependencies = Omit<InstallArguments[3], 'client'> & {
  client: Omit<InstallClient, DefaultedClientMethods> &
    Partial<Pick<InstallClient, DefaultedClientMethods>>;
};

function unexpectedCloudflareCall(name: string) {
  return async (): Promise<never> => {
    throw new Error(`Unexpected Cloudflare call: ${name}`);
  };
}

// These lifecycle fixtures model an already uncached dedicated database. Cache
// drift, adoption, and verification failures are exercised by platform-auth-database.test.ts.
function installPlatform(
  plan: InstallArguments[0],
  secrets: InstallArguments[1],
  existing: InstallArguments[2],
  dependencies: TestInstallerDependencies,
) {
  return installPlatformImplementation(plan, secrets, existing, {
    ...dependencies,
    client: {
      apiBaseUrl: resolvePinnedApiBaseUrl(),
      deleteKvValue: async () => {},
      getWorkerPlainTextBindings: unexpectedCloudflareCall('getWorkerPlainTextBindings'),
      listWorkerDomains: unexpectedCloudflareCall('listWorkerDomains'),
      listWorkerNames: unexpectedCloudflareCall('listWorkerNames'),
      listWorkerRoutes: unexpectedCloudflareCall('listWorkerRoutes'),
      listWorkerServiceRoutes: unexpectedCloudflareCall('listWorkerServiceRoutes'),
      publishWorkerCustomDomainsSafely: unexpectedCloudflareCall(
        'publishWorkerCustomDomainsSafely',
      ),
      publishWorkerRoutesSafely: unexpectedCloudflareCall('publishWorkerRoutesSafely'),
      request: unexpectedCloudflareCall('request'),
      ...dependencies.client,
      getHyperdriveConfig:
        dependencies.client.getHyperdriveConfig ??
        (async (_account, id) => ({
          id,
          name: plan.actions.find((action) => action.key === 'hyperdrive')!.name,
          origin: hyperdriveOriginFromConnectionString(secrets.databaseUrl),
          cachingDisabled: true,
        })),
      disableHyperdriveCaching: dependencies.client.disableHyperdriveCaching ?? (async () => {}),
    },
  });
}
const TEST_PLATFORM_JWT_SECRET = 'test-only-platform-jwt-secret-material';
const TEST_PLATFORM_EMAIL_SIGNING_SECRET = 'test-only-email-signing-secret-material';
const TEST_PLATFORM_PROJECT_SECRET_KEY = Buffer.alloc(32, 5).toString('base64');

async function prepareDatabase() {
  return { appliedMigrations: 0, previousSchemaDigest: '', schemaDigest: '' };
}

function sandboxDrainPreparation(state: 'complete' | 'pending') {
  return {
    admissionProtocol: 3 as const,
    generation: 'generation-1',
    state,
  } as const;
}

beforeEach(() => {
  process.env.VOID_PLATFORM_RECOVERY_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  delete process.env.VOID_PLATFORM_RECOVERY_KEY;
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  delete process.env.CF_ACCESS_CLIENT_ID;
  delete process.env.CF_ACCESS_CLIENT_SECRET;
  delete process.env.VOID_ACCESS_CREDENTIALS;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function planningClient() {
  return {
    listAccounts: async () => [{ id: 'account', name: 'Account' }],
    getWorkersSubdomain: async () => 'workers-subdomain',
    hasActiveCertificateForHostname: async () => true,
    getKvValue: async () => null,
    getR2Object: async () => null,
    getWorkerPlainTextBindings: async () => ({}),
    listAiGateways: async () => [],
    findZone: async () => ({
      id: 'zone-id',
      name: 'example.com',
      nameServers: [],
      status: 'active',
    }),
    findZoneForHostname: async () => null,
    listDnsRecords: async () => [],
    listKvNamespaces: async () => [],
    listR2Buckets: async () => [],
    listQueues: async () => [],
    listDispatchNamespaces: async () => [],
    listHyperdriveConfigs: async () => [],
    listWorkerNames: async () => [],
    listWorkerDomains: async () => [],
    listWorkerRoutes: async () => [],
  };
}

const FRESH_SECRETS_INPUT = {
  bootstrapGitHubId: '583231',
  bootstrapGitHubLogin: 'octocat',
  cloudflareApiToken: 'cf-token',
  databaseUrl: 'postgres://user:password@db.example.com/void',
  githubClientId: 'github-id',
  githubClientSecret: 'github-secret',
  jwtSecret: TEST_PLATFORM_JWT_SECRET,
  projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
  r2AccessKeyId: 'r2-id',
  r2SecretAccessKey: 'r2-secret',
};

function freshSecrets(
  overrides: Partial<Parameters<typeof createPlatformInstallationSecrets>[0]> = {},
) {
  return createPlatformInstallationSecrets({ ...FRESH_SECRETS_INPUT, ...overrides });
}

const EXAMPLE_PLAN_INPUT = {
  accountId: 'account',
  applicationDomain: 'apps.example.com',
  controlPlaneDomain: '',
  dedicatedZone: false,
  displayName: 'Example',
  installationSlug: 'example',
  zoneName: 'example.com',
};

function examplePlan(
  existing: Parameters<typeof createPlatformInstallPlan>[2] = null,
  overrides: Partial<Parameters<typeof createPlatformInstallPlan>[1]> = {},
) {
  return createPlatformInstallPlan(
    planningClient(),
    { ...EXAMPLE_PLAN_INPUT, ...overrides },
    existing,
  );
}

function useRegistryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-installer-test-'));
  directories.push(directory);
  process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
  return directory;
}

/** A client for runs that stop before any resource is created. */
function unusedClient(): TestInstallerDependencies['client'] {
  const unused = async () => ({ id: 'unused', name: 'unused' });
  return {
    createAiGateway: unused,
    createDispatchNamespace: unused,
    createDnsRecord: async () => ({
      content: '100::',
      id: 'unused',
      name: 'unused',
      proxied: true,
      type: 'AAAA',
    }),
    createHyperdrive: unused,
    createKvNamespace: unused,
    createQueue: unused,
    createR2Bucket: unused,
    createZone: async () => ({ id: 'unused', name: 'unused', nameServers: [], status: 'active' }),
    putKvValue: async () => {},
    putR2Object: async () => {},
  };
}

/** A client that creates every planned resource in the existing example.com zone. */
function creatingClient(): TestInstallerDependencies['client'] {
  let index = 0;
  const create = async (_account: string, name: string) => ({ id: `id-${index++}`, name });
  return {
    createAiGateway: create,
    createDispatchNamespace: create,
    createDnsRecord: async (_zone, name) => ({
      content: '100::',
      id: `id-${index++}`,
      name,
      proxied: true,
      type: 'AAAA',
    }),
    createHyperdrive: async (account, name) => create(account, name),
    createKvNamespace: create,
    createQueue: create,
    createR2Bucket: create,
    createZone: async () => {
      throw new Error('existing zone must not be created');
    },
    putKvValue: async () => {},
    putR2Object: async () => {},
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    server.closeAllConnections();
  });
}

describe('platform installer', () => {
  const claimDatabase = async () => {};
  const acquireDatabaseLifecycleLock = async () =>
    Object.assign(async () => {}, {
      prepareSandboxDrain: async () => sandboxDrainPreparation('complete'),
    });

  it.each([
    createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Schema 1',
      installationSlug: 'schema-1',
    }),
    createPlatformDeploymentManifest({
      application: {
        baseDomain: 'example.workers.dev',
        zoneName: '',
        workersDev: { installationId: 'schema-2-a1b2c3d4', subdomain: 'example' },
      },
      displayName: 'Schema 2',
      installationSlug: 'schema-2',
    }),
  ])(
    'normalizes schema $schemaVersion with database-authoritative authentication state',
    (deployment) => {
      expect(
        mergePlatformLiveAuthenticationDeployment(deployment, {
          enabledProviders: ['google', 'oidc'],
          protectedByAccess: true,
          sessionsRequired: true,
        }),
      ).toMatchObject({
        schemaVersion: 3,
        authentication: {
          accessProtection: true,
          configurable: true,
          providers: ['google', 'oidc'],
        },
        capabilities: { githubOAuth: false, googleOAuth: true },
      });
    },
  );

  it.each([
    { kind: 'github' as const, protection: false },
    { kind: 'google' as const, protection: false },
    { kind: 'oidc' as const, protection: false },
    { kind: 'cloudflare-access' as const, protection: false },
    { kind: 'github' as const, protection: true },
    { kind: 'cloudflare-access' as const, protection: true },
  ])(
    'installs $kind with Access protection=$protection and initializes auth after deploying the API',
    async ({ kind, protection }) => {
      useRegistryDirectory();
      const plan = await createPlatformInstallPlan(
        planningClient(),
        {
          accountId: 'account',
          installationSlug: 'google-team',
          displayName: 'Google Team',
          applicationDomain: '',
          zoneName: '',
          controlPlaneDomain: '',
          dedicatedZone: false,
          workersDev: true,
          authentication: {
            providers: [kind],
            configurable: true,
            ...(protection ? { accessProtection: true } : {}),
          },
        },
        null,
      );
      const code = 'a'.repeat(64);
      const setupJson = JSON.stringify({
        connections: [
          {
            configuration: {
              id: kind === 'cloudflare-access' ? 'access' : kind,
              kind,
              label: kind,
              clientId: 'test-client',
              ...(kind === 'google' ? { allowedDomains: ['example.com'] } : {}),
              ...(kind === 'oidc' ? { issuer: 'https://id.example.com' } : {}),
              ...(kind === 'cloudflare-access'
                ? {
                    issuer:
                      'https://company.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test-client',
                  }
                : {}),
            },
            clientSecret: 'google-secret',
          },
        ],
        administratorConnectionId: kind === 'cloudflare-access' ? 'access' : kind,
        bootstrapCredentialHash: createHash('sha256').update(code).digest('hex'),
        admission: protection
          ? { mode: 'company', connections: [], access: true }
          : { mode: 'restricted' },
        protection: protection
          ? {
              teamDomain: 'https://company.cloudflareaccess.com',
              applications: [
                { origin: plan.apiUrl, audience: 'api-audience' },
                { origin: plan.proxyUrl, audience: 'proxy-audience' },
                { origin: 'https://dashboard.example.com', audience: 'dashboard-audience' },
              ],
            }
          : null,
      });
      const secrets = createPlatformInstallationSecrets({
        bootstrapGitHubId: '',
        bootstrapGitHubLogin: '',
        githubClientId: '',
        githubClientSecret: '',
        cloudflareApiToken: 'runtime',
        databaseUrl: 'postgresql://user:password@db.example.com/platform',
        jwtSecret: TEST_PLATFORM_JWT_SECRET,
        projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
        r2AccessKeyId: 'r2',
        r2SecretAccessKey: 'r2-secret',
        configurableAuthentication: true,
        authSetupToken: 't'.repeat(64),
        authBootstrapCode: code,
        checkpoint: { managementApiToken: 'local-management-secret' },
      });
      const deployed: Array<{
        config: Record<string, unknown>;
        secrets: Record<string, string> | null;
      }> = [];
      const create = async (_account: string, name: string) => ({ id: `${name}-id`, name });
      let initialized = 0;
      let verifiedProtection = 0;
      let verifiedHealthAccess = 0;
      let claimed = false;
      let prepared = false;
      const progress: Array<string> = [];
      const result = await installPlatform(plan, secrets, null, {
        onProgress: (message) => progress.push(message),
        verifyAccessProtection: async (input) => {
          verifiedProtection++;
          expect(input.protection).toEqual(JSON.parse(setupJson).protection);
          expect(deployed).toHaveLength(0);
          expect(prepared).toBe(true);
        },
        prepareHealthAccess: async (input) => {
          verifiedHealthAccess++;
          expect(verifiedProtection).toBe(1);
          expect(deployed).toHaveLength(0);
          expect(input.checkpoint.accessProvisioningJson).toBeTruthy();
          input.save(
            JSON.stringify({
              version: 1,
              accountId: 'account',
              installationId: input.manifest.id,
              nonce: 'a'.repeat(32),
              resources: {
                'health-dispatch': {
                  id: 'health-app',
                  name: 'Health check',
                  fingerprint: 'test',
                  pending: false,
                },
              },
            }),
          );
        },
        claimDatabase: async () => {
          claimed = true;
        },
        acquireDatabaseLifecycleLock,
        prepareAuthentication: async (manifest) => {
          expect(claimed).toBe(true);
          expect(deployed).toHaveLength(0);
          prepared = true;
          return {
            authenticationSetupJson: setupJson,
            ...(protection
              ? {
                  accessCredentialsJson: JSON.stringify(
                    Object.fromEntries(
                      [plan.apiUrl, plan.proxyUrl, 'https://dashboard.example.com'].map(
                        (origin) => [
                          origin,
                          {
                            CF_ACCESS_CLIENT_ID: 'service-client',
                            CF_ACCESS_CLIENT_SECRET: 'service-secret',
                          },
                        ],
                      ),
                    ),
                  ),
                  accessProvisioningJson: JSON.stringify({
                    version: 1,
                    accountId: 'account',
                    installationId: manifest.id,
                    resources: {
                      protection: {
                        id: 'access-app',
                        name: 'Protection',
                        adopted: true,
                        pending: false,
                        fingerprint: 'test',
                      },
                    },
                  }),
                }
              : {}),
          };
        },
        client: {
          createAiGateway: create,
          createDispatchNamespace: create,
          createHyperdrive: create,
          createKvNamespace: create,
          createQueue: create,
          createR2Bucket: create,
          createDnsRecord: async () => {
            throw new Error('No DNS expected');
          },
          createZone: async () => {
            throw new Error('No zone expected');
          },
          putKvValue: async () => {},
          deleteKvValue: async () => {},
          putR2Object: async () => {},
        },
        deployWorker: async (config, payload) => {
          expect(prepared).toBe(true);
          if (protection) {
            expect(config.preview_urls).toBe(false);
          }
          deployed.push({ config, secrets: payload });
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {},
        initializeAuthentication: async (url, id, token, json) => {
          initialized++;
          expect(url).toBe(plan.apiUrl);
          expect(id).toBe(plan.installationId);
          expect(token).toBe(secrets.authSetupToken);
          expect(json).toBe(setupJson);
          const api = deployed.find(
            (worker) => worker.config.name === plan.deployment.resources.apiWorker,
          )!;
          expect(api.secrets).toHaveProperty('PLATFORM_AUTH_SETUP_TOKEN', secrets.authSetupToken);
          expect(api.secrets).not.toHaveProperty('GITHUB_CLIENT_SECRET');
          expect(api.config.vars).toHaveProperty('PLATFORM_AUTH_DATABASE_UNCACHED', 'true');
          expect(api.config.assets).toEqual({
            directory: toSlash(join(getPlatformRuntimeDirectory(), 'api', 'assets')),
          });
          return { setupPending: true, expiresAt: new Date(Date.now() + 1_800_000).toISOString() };
        },
      });
      expect(initialized).toBe(1);
      // The setup page answers only once traffic opens, after this progress line.
      expect(progress).toContain(
        'Administrator setup prepared; its link and code are shown when this finishes',
      );
      expect(progress.filter((message) => message.includes('/setup'))).toEqual([]);
      expect(verifiedProtection).toBe(protection ? 1 : 0);
      expect(verifiedHealthAccess).toBe(protection ? 1 : 0);
      expect(result.manifest.status).toBe('installed');
      expect(readInstallationRecoverySecrets(result.manifest)?.managementApiToken).toBe(
        'local-management-secret',
      );
      expect(JSON.stringify(deployed)).not.toContain('local-management-secret');
      expect(JSON.stringify(result.manifest)).not.toContain('local-management-secret');
      expect(result.manifest.deployment.authentication).toEqual({
        providers: [kind],
        configurable: true,
        ...(protection ? { accessProtection: true } : {}),
      });
      if (protection) {
        expect(result.manifest.authenticationResources).toMatchObject([
          { id: 'access-app', ownership: 'adopted' },
          { id: 'health-app', ownership: 'created' },
        ]);
        expect(
          readInstallationRecoverySecrets(result.manifest)?.accessHealthProvisioningJson,
        ).toContain('health-app');
      }
      expect(JSON.stringify(result.manifest)).not.toContain('google-secret');
      expect(JSON.stringify(result.manifest)).not.toContain(code);
      expect(
        result.manifest.steps.some((step) => step.key.startsWith('authentication-initialized:v1:')),
      ).toBe(true);
    },
  );

  it.each([
    { fromDraft: false, dashboardUrl: undefined },
    { fromDraft: true, dashboardUrl: undefined },
    { fromDraft: true, dashboardUrl: 'https://dash.example.org:8443' },
  ])(
    'installs core Workers without a zone and probes the dispatch hostname (draft: $fromDraft, dashboard: $dashboardUrl)',
    async ({ fromDraft, dashboardUrl }) => {
      useRegistryDirectory();
      const forbidden = async (): Promise<never> => {
        throw new Error('no zone or DNS access allowed');
      };
      const plan = await createPlatformInstallPlan(
        {
          ...planningClient(),
          findZone: forbidden,
          listDnsRecords: forbidden,
          listWorkerRoutes: forbidden,
          hasActiveCertificateForHostname: forbidden,
        },
        {
          accountId: 'account',
          applicationDomain: '',
          zoneName: '',
          workersDev: true,
          controlPlaneDomain: '',
          ...(dashboardUrl ? { dashboardUrl } : {}),
          dedicatedZone: false,
          displayName: 'Testing',
          installationSlug: 'testing',
        },
        null,
      );
      let index = 0;
      const create = async (_account: string, name: string) => ({
        id: `resource-${index++}`,
        name,
      });
      const configs: Array<Record<string, unknown>> = [];
      const secrets = freshSecrets();
      const draft = fromDraft
        ? completePlatformSetupDraft(
            savePlatformSetupDraft(plan, resolvePlatformRuntime().manifest.platformVersion),
          )
        : null;
      const progress: Array<string> = [];
      const result = await installPlatform(plan, secrets, draft, {
        onProgress: (message) => progress.push(message),
        claimDatabase,
        acquireDatabaseLifecycleLock,
        client: {
          createAiGateway: create,
          createDnsRecord: forbidden,
          createZone: forbidden,
          createKvNamespace: create,
          createR2Bucket: create,
          createQueue: create,
          createDispatchNamespace: create,
          createHyperdrive: create,
          putKvValue: async () => {},
          deleteKvValue: async () => {},
          putR2Object: async () => {},
        },
        deployWorker: async (config) => {
          expect(progress.at(-1)).toMatch(
            /^(Deploying|Enabling) the (api|proxy|emailGateway|tail|dispatch) service/,
          );
          if (config.name === plan.deployment.resources.apiWorker) {
            const enabled =
              (config.vars as Record<string, string>).PLATFORM_TRAFFIC_STATE === 'enabled';
            expect(config.services).toEqual(
              enabled
                ? [
                    {
                      binding: 'PREVIEW_DISPATCH',
                      service: plan.deployment.resources.dispatchWorker,
                      entrypoint: 'PreviewDispatcher',
                    },
                    { binding: 'PLATFORM_PROXY', service: plan.deployment.resources.proxyWorker },
                  ]
                : undefined,
            );
            if (enabled) {
              expect(
                configs.some((prior) => prior.name === plan.deployment.resources.proxyWorker),
              ).toBe(true);
            }
          }
          configs.push(config);
        },
        prepareDatabase: async () => {
          expect(progress.at(-1)).toBe('Applying platform database migrations');
          return prepareDatabase();
        },
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async (
          _api,
          _id,
          _proxy,
          _domain,
          _version,
          _protocol,
          _token,
          _fetcher,
          dispatchOrigin,
          context,
        ) => {
          expect(dispatchOrigin).toBe(
            `https://${plan.deployment.resources.dispatchWorker}.workers-subdomain.workers.dev`,
          );
          expect(context).toEqual({
            accountName: plan.account.name,
            workers: [
              plan.deployment.resources.apiWorker,
              plan.deployment.resources.proxyWorker,
              plan.deployment.resources.dispatchWorker,
            ],
            resumeCommand: undefined,
          });
        },
      });
      expect(result.manifest.status).toBe('installed');
      expect(result.manifest.endpoints.dashboardUrl).toBe(dashboardUrl ?? null);
      const apiConfig = configs.find(
        (config) => config.name === plan.deployment.resources.apiWorker,
      )!;
      if (dashboardUrl) {
        expect(apiConfig.vars).toHaveProperty('DASHBOARD_URL', dashboardUrl);
      } else {
        expect(apiConfig.vars).not.toHaveProperty('DASHBOARD_URL');
      }
      expect(
        result.manifest.resources.some(
          (resource) => resource.kind === 'zone' || resource.kind === 'dns-record',
        ),
      ).toBe(false);
      expect(new Set(configs.map((config) => config.name)).size).toBe(5);
      expect(
        configs.every((config) => !config.routes || (config.routes as Array<unknown>).length === 0),
      ).toBe(true);
      expect(parsePlatformInstallationManifest(result.manifest)).toEqual(result.manifest);
    },
  );

  it('lifts a left-over uninstall fence before traffic opens', async () => {
    useRegistryDirectory();
    const plan = await createPlatformInstallPlan(
      planningClient(),
      {
        accountId: 'account',
        applicationDomain: '',
        zoneName: '',
        workersDev: true,
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: 'Fenced',
        installationSlug: 'fenced',
      },
      null,
    );
    let index = 0;
    const create = async (_account: string, name: string) => ({
      id: `resource-${index++}`,
      name,
    });
    const events: Array<string> = [];
    const result = await installPlatform(plan, freshSecrets(), null, {
      claimDatabase,
      acquireDatabaseLifecycleLock: async () =>
        Object.assign(async () => {}, {
          prepareSandboxDrain: async () => sandboxDrainPreparation('complete'),
          liftProjectZeroTrustFence: async () => {
            events.push('lift fence');
          },
        }),
      client: {
        createAiGateway: create,
        createDnsRecord: async () => {
          throw new Error('no DNS expected');
        },
        createZone: async () => {
          throw new Error('no zone expected');
        },
        createKvNamespace: create,
        createR2Bucket: create,
        createQueue: create,
        createDispatchNamespace: create,
        createHyperdrive: create,
        putKvValue: async () => {},
        deleteKvValue: async (_account, _namespace, key) => {
          if (key === PLATFORM_DISABLED_KEY) {
            events.push('enable traffic');
          }
        },
        putR2Object: async () => {},
      },
      deployWorker: async () => {},
      prepareDatabase,
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
    });
    expect(result.manifest.status).toBe('installed');
    expect(events).toEqual(['lift fence', 'enable traffic']);
  });

  it('keeps traffic disabled and the verified Worker set when shared email bootstrap blocks', async () => {
    const directory = useRegistryDirectory();
    const plan = await createPlatformInstallPlan(
      planningClient(),
      {
        accountId: 'account',
        applicationDomain: '',
        zoneName: '',
        workersDev: true,
        controlPlaneDomain: '',
        dedicatedZone: false,
        displayName: 'Email',
        emailSenderDomain: 'mail.example.com',
        emailSharedZoneId: 'mail-zone-id',
        installationSlug: 'email',
      },
      null,
    );
    const secrets = freshSecrets({ emailEnabled: true });
    let index = 0;
    const create = async (_account: string, name: string) => ({
      id: `resource-${index++}`,
      name,
    });
    const rollbacks: Array<string> = [];
    const deletedKeys: Array<string> = [];
    const kvWrites: Array<{ key: string; value: string }> = [];
    const bootstrapEmail = vi.fn(async () => {
      throw new Error('shared email operation is blocked');
    });

    await expect(
      installPlatform(plan, secrets, null, {
        claimDatabase,
        acquireDatabaseLifecycleLock,
        bootstrapEmail,
        client: {
          createAiGateway: create,
          createDnsRecord: async () => {
            throw new Error('no DNS expected');
          },
          createZone: async () => {
            throw new Error('no zone expected');
          },
          createKvNamespace: create,
          createR2Bucket: create,
          createQueue: create,
          createDispatchNamespace: create,
          createHyperdrive: create,
          putKvValue: async (_account, _namespace, key, value) => {
            kvWrites.push({ key, value });
          },
          deleteKvValue: async (_account, _namespace, key) => {
            deletedKeys.push(key);
          },
          putR2Object: async () => {},
        },
        deployWorker: async (config) => async () => {
          rollbacks.push(String(config.name));
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {},
      }),
    ).rejects.toThrow('shared email operation is blocked');

    expect(bootstrapEmail).toHaveBeenCalledTimes(1);
    expect(deletedKeys).not.toContain(PLATFORM_DISABLED_KEY);
    expect(kvWrites).toContainEqual({ key: PLATFORM_DISABLED_KEY, value: PLATFORM_DISABLED_VALUE });
    expect(rollbacks).toEqual([]);
    const failed = listInstallationManifests(directory)[0]!;
    expect(failed.status).toBe('failed');
    expect(
      failed.steps.some(
        (step) => step.key.startsWith('worker-cutover:') && step.resultHash === 'committed',
      ),
    ).toBe(true);
    expect(
      failed.steps.some(
        (step) => step.key.startsWith('worker-traffic-state:') && step.resultHash === 'enabled',
      ),
    ).toBe(false);
  });

  it('requires externally custodied identity keys for a fresh installation', () => {
    const {
      jwtSecret: _jwtSecret,
      projectSecretKey: _projectSecretKey,
      ...input
    } = FRESH_SECRETS_INPUT;

    expect(() => createPlatformInstallationSecrets(input)).toThrow(
      'VOID_PLATFORM_JWT_SECRET is required',
    );
    expect(() =>
      createPlatformInstallationSecrets({ ...input, jwtSecret: TEST_PLATFORM_JWT_SECRET }),
    ).toThrow('VOID_PLATFORM_PROJECT_SECRET_KEY is required');
    expect(() =>
      createPlatformInstallationSecrets({
        ...input,
        jwtSecret: 'short',
        projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
      }),
    ).toThrow('at least 32 bytes');
    expect(() =>
      createPlatformInstallationSecrets({
        ...input,
        jwtSecret: TEST_PLATFORM_JWT_SECRET,
        projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY.replace(/=+$/, ''),
      }),
    ).toThrow('canonical base64');
    expect(() =>
      createPlatformInstallationSecrets({
        ...input,
        jwtSecret: TEST_PLATFORM_JWT_SECRET,
        projectSecretActiveKeyVersion: 'v1',
        projectSecretKeysJson: JSON.stringify({ v1: TEST_PLATFORM_PROJECT_SECRET_KEY }),
      }),
    ).toThrow('Fresh installations use VOID_PLATFORM_PROJECT_SECRET_KEY');
    expect(
      createPlatformInstallationSecrets({
        ...input,
        jwtSecret: TEST_PLATFORM_JWT_SECRET,
        projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
      }),
    ).toMatchObject({
      jwtSecret: TEST_PLATFORM_JWT_SECRET,
      projectSecretActiveKeyVersion: 'v1',
      projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
      projectSecretKeysJson: JSON.stringify({ v1: TEST_PLATFORM_PROJECT_SECRET_KEY }),
    });
  });

  it('generates missing identity keys only for a fresh install that keeps recovery data', () => {
    const {
      jwtSecret: _jwtSecret,
      projectSecretKey: _projectSecretKey,
      ...input
    } = FRESH_SECRETS_INPUT;
    const generated = createPlatformInstallationSecrets({
      ...input,
      emailEnabled: true,
      generateIdentityKeys: true,
    });
    expect(Buffer.byteLength(generated.jwtSecret, 'utf8')).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(generated.projectSecretKey, 'base64')).toHaveLength(32);
    expect(generated.projectSecretKeysJson).toBe(
      JSON.stringify({ v1: generated.projectSecretKey }),
    );
    expect(
      new Set([generated.jwtSecret, generated.projectSecretKey, generated.emailSigningSecret]).size,
    ).toBe(3);

    expect(
      createPlatformInstallationSecrets({
        ...input,
        generateIdentityKeys: true,
        jwtSecret: TEST_PLATFORM_JWT_SECRET,
        checkpoint: { projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY },
      }),
    ).toMatchObject({
      jwtSecret: TEST_PLATFORM_JWT_SECRET,
      projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
    });
    expect(
      createPlatformInstallationSecrets({
        ...input,
        existingInstallation: true,
        generateIdentityKeys: true,
      }),
    ).toMatchObject({ jwtSecret: '', projectSecretKey: '' });
  });

  it('generates and preserves a dedicated email signing key only for email installations', () => {
    const emailDisabled = freshSecrets({
      emailSigningSecret: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
    });
    expect(emailDisabled.emailSigningSecret).toBe('');
    expect(apiWorkerSecrets(emailDisabled, 'account', 'zone')).not.toHaveProperty(
      'EMAIL_SIGNING_SECRET',
    );
    expect(
      platformWorkerSecretPayload('emailGateway', emailDisabled, 'account', 'zone', false),
    ).toBeNull();
    const existingEmailDisabled = freshSecrets({
      emailSigningSecret: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
      existingInstallation: true,
      updateExistingWorkers: true,
    });
    expect(existingEmailDisabled.emailSigningSecret).toBe('');
    expect(existingEmailDisabled.workerSecretUpdates).not.toHaveProperty('EMAIL_SIGNING_SECRET');

    const freshEmail = freshSecrets({
      emailEnabled: true,
    });
    expect(Buffer.byteLength(freshEmail.emailSigningSecret, 'utf8')).toBeGreaterThanOrEqual(32);
    expect(freshEmail.emailSigningSecret).not.toBe(TEST_PLATFORM_JWT_SECRET);
    expect(apiWorkerSecrets(freshEmail, 'account', 'zone')).toHaveProperty(
      'EMAIL_SIGNING_SECRET',
      freshEmail.emailSigningSecret,
    );
    expect(
      platformWorkerSecretPayload('proxy', freshEmail, 'account', 'zone', false),
    ).toMatchObject({
      EMAIL_SIGNING_SECRET: freshEmail.emailSigningSecret,
      JWT_SECRET: TEST_PLATFORM_JWT_SECRET,
    });
    expect(
      platformWorkerSecretPayload('emailGateway', freshEmail, 'account', 'zone', false),
    ).toEqual({ EMAIL_SIGNING_SECRET: freshEmail.emailSigningSecret });

    expect(() =>
      freshSecrets({
        emailEnabled: true,
        emailSigningSecret: TEST_PLATFORM_JWT_SECRET,
      }),
    ).toThrow('must be different from VOID_PLATFORM_JWT_SECRET');

    const existingInput = {
      ...FRESH_SECRETS_INPUT,
      existingInstallation: true,
      emailEnabled: true,
      existingEmailEnabled: true,
    };
    expect(() => createPlatformInstallationSecrets(existingInput)).toThrow(
      'VOID_PLATFORM_EMAIL_SIGNING_SECRET is required',
    );
    expect(() =>
      createPlatformInstallationSecrets({
        ...existingInput,
        emailSigningSecret: 'short',
      }),
    ).toThrow('at least 32 bytes');
    expect(() =>
      createPlatformInstallationSecrets({
        ...existingInput,
        checkpoint: {
          jwtSecret: TEST_PLATFORM_JWT_SECRET,
          emailSigningSecret: TEST_PLATFORM_JWT_SECRET,
        },
        emailSigningSecret: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
      }),
    ).toThrow('must be different from VOID_PLATFORM_JWT_SECRET');
    const restored = createPlatformInstallationSecrets({
      ...existingInput,
      checkpoint: { emailSigningSecret: TEST_PLATFORM_EMAIL_SIGNING_SECRET },
      emailSigningSecret: 'wrong-email-signing-secret-that-must-not-win',
      updateExistingWorkers: true,
    });
    expect(restored.emailSigningSecret).toBe(TEST_PLATFORM_EMAIL_SIGNING_SECRET);
    expect(restored.workerSecretUpdates).toEqual({
      CF_API_TOKEN: 'cf-token',
      EMAIL_SIGNING_SECRET: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
      GITHUB_CLIENT_ID: 'github-id',
      GITHUB_CLIENT_SECRET: 'github-secret',
      R2_ACCESS_KEY_ID: 'r2-id',
      R2_SECRET_ACCESS_KEY: 'r2-secret',
    });
    expect(platformWorkerSecretPayload('api', restored, 'account', 'zone', true)).toEqual(
      restored.workerSecretUpdates,
    );
    expect(platformWorkerSecretPayload('proxy', restored, 'account', 'zone', true)).toEqual({
      CF_API_TOKEN: 'cf-token',
      EMAIL_SIGNING_SECRET: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
    });
    expect(platformWorkerSecretPayload('emailGateway', restored, 'account', 'zone', true)).toEqual({
      EMAIL_SIGNING_SECRET: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
    });

    const disabling = freshSecrets({
      checkpoint: { emailSigningSecret: TEST_PLATFORM_EMAIL_SIGNING_SECRET },
      emailSigningSecret: 'replacement-signal-that-must-not-override-recovery',
      existingInstallation: true,
      existingEmailEnabled: true,
      updateExistingWorkers: true,
    });
    expect(disabling.emailSigningSecret).toBe(TEST_PLATFORM_EMAIL_SIGNING_SECRET);
    expect(disabling.workerSecretUpdates).toHaveProperty(
      'EMAIL_SIGNING_SECRET',
      TEST_PLATFORM_EMAIL_SIGNING_SECRET,
    );
    expect(() =>
      freshSecrets({
        checkpoint: { emailSigningSecret: 'short' },
        existingInstallation: true,
        existingEmailEnabled: true,
      }),
    ).toThrow('at least 32 bytes');
    expect(
      freshSecrets({
        existingInstallation: true,
        existingEmailEnabled: true,
      }).emailSigningSecret,
    ).toBe('');
  });

  it('checkpoints a first-enable email key as a resumable Worker secret update', () => {
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: '',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      emailEnabled: true,
      existingEmailEnabled: false,
      existingInstallation: true,
      githubClientId: '',
      githubClientSecret: '',
      jwtSecret: '',
      projectSecretKey: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
      updateExistingWorkers: true,
    });
    expect(secrets.workerSecretUpdates).toEqual({
      EMAIL_SIGNING_SECRET: secrets.emailSigningSecret,
    });
    for (const worker of ['api', 'proxy', 'emailGateway'] as const) {
      expect(platformWorkerSecretPayload(worker, secrets, 'account', 'zone', true)).toEqual({
        EMAIL_SIGNING_SECRET: secrets.emailSigningSecret,
      });
    }
  });

  it('does not let an email-disable plan bypass an unresolved email secret update', async () => {
    useRegistryDirectory();
    const currentDeployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      capabilities: { email: true },
      displayName: 'Example',
      emailSenderDomain: 'mail.example.com',
      emailSharedZoneId: 'mail-zone',
      installationSlug: 'example',
    });
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-20T00:00:00.000Z',
      deployment: currentDeployment,
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-20T00:00:01.000Z',
        key: 'worker-secret-updates:1:pending',
        resultHash: 'foreign-email-intent',
      },
      '2026-09-20T00:00:01.000Z',
    );
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-20T00:00:02.000Z',
        key: 'worker-cutover:1:restored',
        resultHash: 'restored',
      },
      '2026-09-20T00:00:02.000Z',
    );
    writeInstallationManifest(manifest);
    const currentPlan = await examplePlan(manifest);
    const plan = {
      ...currentPlan,
      deployment: createPlatformDeploymentManifest({
        ...currentPlan.deployment,
        capabilities: { ...currentPlan.deployment.capabilities, email: false },
      }),
    };
    const secrets = freshSecrets({
      checkpoint: { emailSigningSecret: TEST_PLATFORM_EMAIL_SIGNING_SECRET },
      existingEmailEnabled: true,
      existingInstallation: true,
      updateExistingWorkers: true,
    });
    expect(secrets.workerSecretUpdates).not.toHaveProperty('EMAIL_SIGNING_SECRET');
    const deployWorker = vi.fn();

    await expect(
      installPlatform(plan, secrets, manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: {} as never,
        deployWorker,
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('owned by another encrypted recovery checkpoint');
    expect(deployWorker).not.toHaveBeenCalled();
  });

  it('validates complete project-secret keyring restoration inputs', () => {
    const {
      jwtSecret: _jwtSecret,
      projectSecretKey: _projectSecretKey,
      ...fresh
    } = FRESH_SECRETS_INPUT;
    const input = { ...fresh, existingInstallation: true };
    expect(() =>
      createPlatformInstallationSecrets({
        ...input,
        projectSecretKeysJson: JSON.stringify({ v1: TEST_PLATFORM_PROJECT_SECRET_KEY }),
      }),
    ).toThrow('must be supplied together');
    expect(() =>
      createPlatformInstallationSecrets({
        ...input,
        projectSecretActiveKeyVersion: 'v2',
        projectSecretKeysJson: JSON.stringify({ v1: TEST_PLATFORM_PROJECT_SECRET_KEY }),
      }),
    ).toThrow('must identify a key');
    expect(() =>
      createPlatformInstallationSecrets({
        ...input,
        projectSecretActiveKeyVersion: 'v1',
        projectSecretKeysJson: JSON.stringify({
          v1: TEST_PLATFORM_PROJECT_SECRET_KEY.replace(/=+$/, ''),
        }),
      }),
    ).toThrow('canonical base64');
  });

  it('attempts Worker rollback even when closing an unsafe routing gate fails', async () => {
    const events: Array<string> = [];
    const failures = await recoverFailedPlatformWorkerDeployment({
      checkpointUnsafeTraffic: async () => {
        events.push('checkpoint');
      },
      closeRoutingGate: async () => {
        events.push('gate');
        throw new Error('KV unavailable');
      },
      rollback: async () => {
        events.push('rollback');
      },
      unsafeTraffic: true,
    });

    expect(events).toEqual(['gate', 'checkpoint', 'rollback']);
    expect(failures).toEqual(['closing the routing gate failed: KV unavailable']);
  });

  it.each([
    '',
    '?excludeScript=true',
    '?bindings_inherit=strict',
    '?excludeScript=true&bindings_inherit=strict',
    '?bindings_inherit=strict&excludeScript=true',
  ])('creates a new Worker through a conditional API request with %s', async (query) => {
    const requests: Array<{
      authorization: string | undefined;
      body: string;
      ifNoneMatch: string | undefined;
      method: string | undefined;
      path: string | undefined;
    }> = [];
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body,
          ifNoneMatch: request.headers['if-none-match'],
          method: request.method,
          path: request.url,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"success":true,"result":{"id":"version"}}');
      });
    });
    const upstreamOrigin = await listen(upstream);
    try {
      await expect(
        withConditionalPlatformWorkerCreate(
          'account',
          'void-api',
          async (apiBaseUrl) => {
            const inspection = await fetch(`${apiBaseUrl}/accounts/account/workers/subdomain`, {
              headers: { Authorization: 'Bearer secret-token' },
            });
            expect(inspection.ok).toBe(true);
            const created = await fetch(
              `${apiBaseUrl}/accounts/account/workers/scripts/void-api${query}`,
              {
                body: 'worker bundle',
                headers: {
                  Authorization: 'Bearer secret-token',
                  'Content-Type': 'text/plain',
                  'If-None-Match': 'must-be-replaced-by-the-guard',
                },
                method: 'PUT',
              },
            );
            expect(created.ok).toBe(true);
            return 'created';
          },
          `${upstreamOrigin}/client/v4`,
        ),
      ).resolves.toBe('created');
      expect(requests).toEqual([
        {
          authorization: 'Bearer secret-token',
          body: '',
          ifNoneMatch: undefined,
          method: 'GET',
          path: '/client/v4/accounts/account/workers/subdomain',
        },
        {
          authorization: 'Bearer secret-token',
          body: 'worker bundle',
          ifNoneMatch: '*',
          method: 'PUT',
          path: '/client/v4/accounts/account/workers/scripts/void-api' + query,
        },
      ]);
    } finally {
      await close(upstream);
    }
  });

  it.each([
    '?excludeScript=false',
    '?bindings_inherit=loose',
    '?token=secret-value',
    '?excludeScript=true&force=true',
    '?excludeScript=true&excludeScript=true',
    '?bindings_inherit=strict&bindings_inherit=loose',
  ])('rejects unsupported or ambiguous create parameters: %s', async (query) => {
    let forwarded = 0;
    const upstream = createServer((_request, response) => {
      forwarded++;
      response.end('{}');
    });
    const origin = await listen(upstream);
    try {
      const result = withConditionalPlatformWorkerCreate(
        'account',
        'void-api',
        async (base) => {
          const response = await fetch(
            `${base}/accounts/account/workers/scripts/void-api${query}`,
            {
              method: 'PUT',
              body: 'worker bundle',
            },
          );
          expect(response.status).toBe(409);
        },
        `${origin}/client/v4`,
      );
      await expect(result).rejects.toThrow('unexpected mutation PUT');
      await expect(result).rejects.not.toThrow('secret-value');
      expect(forwarded).toBe(0);
    } finally {
      await close(upstream);
    }
  });

  it('fails a raced Worker create without exposing credentials', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(412, { 'Content-Type': 'application/json' });
      response.end('{"success":false,"errors":[{"message":"Bearer secret-token already exists"}]}');
    });
    const upstreamOrigin = await listen(upstream);
    try {
      const failure = withConditionalPlatformWorkerCreate(
        'account',
        'void-api',
        async (apiBaseUrl) => {
          await fetch(
            `${apiBaseUrl}/accounts/account/workers/scripts/void-api?excludeScript=true&bindings_inherit=strict`,
            {
              body: 'worker bundle',
              headers: { Authorization: 'Bearer secret-token' },
              method: 'PUT',
            },
          );
        },
        `${upstreamOrigin}/client/v4`,
      );
      await expect(failure).rejects.toThrow('created concurrently (HTTP 412)');
      await expect(failure).rejects.not.toThrow('secret-token');
    } finally {
      await close(upstream);
    }
  });

  it('blocks mutations before the guarded Worker create and closes the proxy', async () => {
    let proxyBaseUrl = '';
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"success":true,"result":{}}');
    });
    const upstreamOrigin = await listen(upstream);
    try {
      await expect(
        withConditionalPlatformWorkerCreate(
          'account',
          'void-api',
          async (apiBaseUrl) => {
            proxyBaseUrl = apiBaseUrl;
            const response = await fetch(
              `${apiBaseUrl}/accounts/account/workers/scripts/other-worker?excludeScript=true&bindings_inherit=strict`,
              { body: 'unconditional bundle', method: 'PUT' },
            );
            expect(response.status).toBe(409);
          },
          `${upstreamOrigin}/client/v4`,
        ),
      ).rejects.toThrow('unexpected mutation PUT');
      await expect(fetch(`${proxyBaseUrl}/accounts/account/workers/subdomain`)).rejects.toThrow();
    } finally {
      await close(upstream);
    }
  });

  it("forwards this Worker's asset upload session and uploads before the guarded create", async () => {
    const hash = '0123456789abcdef0123456789abcdef';
    const requests: Array<{
      authorization: string | undefined;
      ifNoneMatch: string | undefined;
      request: string;
    }> = [];
    const upstream = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          ifNoneMatch: request.headers['if-none-match'],
          request: `${request.method} ${request.url}`,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"success":true,"result":{"jwt":"token"}}');
      });
    });
    const upstreamOrigin = await listen(upstream);
    try {
      await expect(
        withConditionalPlatformWorkerCreate(
          'account',
          'void-api',
          async (apiBaseUrl) => {
            // The order the bundled uploader uses for a new Worker with static assets.
            const sequence: Array<[string, string, string]> = [
              ['GET', '/accounts/account/workers/services/void-api', 'secret-token'],
              ['GET', '/accounts/account/workers/scripts/void-api/deployments', 'secret-token'],
              [
                'POST',
                '/accounts/account/workers/scripts/void-api/assets-upload-session',
                'secret-token',
              ],
              ['POST', '/accounts/account/workers/assets/upload?base64=true', 'session-jwt'],
              ['POST', `/accounts/account/workers/assets/upload/${hash}`, 'session-jwt'],
              ['GET', '/accounts/account/workers/scripts/void-api/settings', 'secret-token'],
              [
                'PUT',
                '/accounts/account/workers/scripts/void-api?excludeScript=true&bindings_inherit=strict',
                'secret-token',
              ],
              ['POST', '/accounts/account/workers/scripts/void-api/subdomain', 'secret-token'],
            ];
            for (const [method, path, token] of sequence) {
              const response = await fetch(`${apiBaseUrl}${path}`, {
                ...(method === 'GET' ? {} : { body: 'payload' }),
                headers: { Authorization: `Bearer ${token}` },
                method,
              });
              expect(response.status, `${method} ${path}`).toBe(200);
            }
            return 'created';
          },
          `${upstreamOrigin}/client/v4`,
        ),
      ).resolves.toBe('created');
      expect(requests).toEqual([
        {
          authorization: 'Bearer secret-token',
          ifNoneMatch: undefined,
          request: 'GET /client/v4/accounts/account/workers/services/void-api',
        },
        {
          authorization: 'Bearer secret-token',
          ifNoneMatch: undefined,
          request: 'GET /client/v4/accounts/account/workers/scripts/void-api/deployments',
        },
        {
          authorization: 'Bearer secret-token',
          ifNoneMatch: undefined,
          request:
            'POST /client/v4/accounts/account/workers/scripts/void-api/assets-upload-session',
        },
        {
          authorization: 'Bearer session-jwt',
          ifNoneMatch: undefined,
          request: 'POST /client/v4/accounts/account/workers/assets/upload?base64=true',
        },
        {
          authorization: 'Bearer session-jwt',
          ifNoneMatch: undefined,
          request: `POST /client/v4/accounts/account/workers/assets/upload/${hash}`,
        },
        {
          authorization: 'Bearer secret-token',
          ifNoneMatch: undefined,
          request: 'GET /client/v4/accounts/account/workers/scripts/void-api/settings',
        },
        {
          authorization: 'Bearer secret-token',
          ifNoneMatch: '*',
          request:
            'PUT /client/v4/accounts/account/workers/scripts/void-api?excludeScript=true&bindings_inherit=strict',
        },
        {
          authorization: 'Bearer secret-token',
          ifNoneMatch: undefined,
          request: 'POST /client/v4/accounts/account/workers/scripts/void-api/subdomain',
        },
      ]);
    } finally {
      await close(upstream);
    }
  });

  const assetSession = [
    'POST',
    '/accounts/account/workers/scripts/void-api/assets-upload-session',
  ] as const;
  it.each<{
    name: string;
    before: ReadonlyArray<readonly [string, string]>;
    blocked: readonly [string, string];
  }>([
    {
      name: 'a session for another Worker',
      before: [],
      blocked: ['POST', '/accounts/account/workers/scripts/other-worker/assets-upload-session'],
    },
    {
      name: 'a session with a query',
      before: [],
      blocked: ['POST', '/accounts/account/workers/scripts/void-api/assets-upload-session?x=1'],
    },
    {
      name: 'a PUT on the session path',
      before: [],
      blocked: ['PUT', '/accounts/account/workers/scripts/void-api/assets-upload-session'],
    },
    {
      name: 'a DELETE on the session path',
      before: [],
      blocked: ['DELETE', '/accounts/account/workers/scripts/void-api/assets-upload-session'],
    },
    {
      name: 'a dispatch namespace session',
      before: [],
      blocked: [
        'POST',
        '/accounts/account/workers/dispatch/namespaces/ns/scripts/void-api/assets-upload-session',
      ],
    },
    {
      name: 'a session under another account',
      before: [],
      blocked: ['POST', '/accounts/other/workers/scripts/void-api/assets-upload-session'],
    },
    {
      name: 'an upload before any session',
      before: [],
      blocked: ['POST', '/accounts/account/workers/assets/upload?base64=true'],
    },
    {
      name: 'an upload with base64=false',
      before: [assetSession],
      blocked: ['POST', '/accounts/account/workers/assets/upload?base64=false'],
    },
    {
      name: 'an upload with an extra query parameter',
      before: [assetSession],
      blocked: ['POST', '/accounts/account/workers/assets/upload?base64=true&x=1'],
    },
    {
      name: 'an upload with a short hash',
      before: [assetSession],
      blocked: ['POST', `/accounts/account/workers/assets/upload/${'a'.repeat(31)}`],
    },
    {
      name: 'an upload with an uppercase hash',
      before: [assetSession],
      blocked: ['POST', `/accounts/account/workers/assets/upload/${'A'.repeat(32)}`],
    },
    {
      name: 'an upload with a nested path',
      before: [assetSession],
      blocked: ['POST', '/accounts/account/workers/assets/upload/a/b'],
    },
    {
      name: 'an upload under another account',
      before: [assetSession],
      blocked: ['POST', '/accounts/other/workers/assets/upload?base64=true'],
    },
    {
      name: 'a version upload after a session',
      before: [assetSession],
      blocked: ['POST', '/accounts/account/workers/scripts/void-api/versions'],
    },
    {
      name: 'a subdomain change after a session',
      before: [assetSession],
      blocked: ['POST', '/accounts/account/workers/scripts/void-api/subdomain'],
    },
    {
      name: 'an unrelated account mutation after a session',
      before: [assetSession],
      blocked: ['POST', '/accounts/account/storage/kv/namespaces'],
    },
    {
      name: 'another Worker upload after a session',
      before: [assetSession],
      blocked: [
        'PUT',
        '/accounts/account/workers/scripts/other-worker?excludeScript=true&bindings_inherit=strict',
      ],
    },
    {
      name: 'an unconditional create after a session',
      before: [assetSession],
      blocked: ['PUT', '/accounts/account/workers/scripts/void-api?excludeScript=false'],
    },
  ])('blocks $name before the guarded create', async ({ before, blocked }) => {
    let forwarded = 0;
    const upstream = createServer((request, response) => {
      forwarded++;
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"success":true,"result":{"jwt":"token"}}');
    });
    const origin = await listen(upstream);
    try {
      const result = withConditionalPlatformWorkerCreate(
        'account',
        'void-api',
        async (base) => {
          for (const [method, path] of before) {
            const response = await fetch(`${base}${path}`, { body: 'payload', method });
            expect(response.status).toBe(200);
          }
          const [method, path] = blocked;
          const response = await fetch(`${base}${path}`, { body: 'payload', method });
          expect(response.status).toBe(409);
        },
        `${origin}/client/v4`,
      );
      await expect(result).rejects.toThrow(`unexpected mutation ${blocked[0]}`);
      expect(forwarded).toBe(before.length);
    } finally {
      await close(upstream);
    }
  });

  it('accepts only an installer deployment with the expected predecessor', () => {
    const ours = {
      id: 'deployment-ours',
      versions: [{ percentage: 100, versionId: 'version-ours' }],
    };
    const previous = {
      id: 'deployment-previous',
      versions: [{ percentage: 100, versionId: 'version-previous' }],
    };
    const intervening = {
      id: 'deployment-intervening',
      versions: [{ percentage: 100, versionId: 'version-intervening' }],
    };

    expect(classifyPlatformWorkerDeploymentLineage([ours], 'version-ours', null)).toEqual({
      deploymentId: 'deployment-ours',
      kind: 'committed',
    });
    expect(
      classifyPlatformWorkerDeploymentLineage(
        [ours, previous],
        'version-ours',
        'deployment-previous',
      ),
    ).toEqual({ deploymentId: 'deployment-ours', kind: 'committed' });
    expect(
      classifyPlatformWorkerDeploymentLineage(
        [ours, intervening, previous],
        'version-ours',
        'deployment-previous',
      ),
    ).toEqual({ deploymentId: 'deployment-ours', kind: 'intervening' });
    expect(
      classifyPlatformWorkerDeploymentLineage(
        [intervening, ours, previous],
        'version-ours',
        'deployment-previous',
      ),
    ).toEqual({ kind: 'concurrent-after' });
  });

  it('normalizes Wrangler deployment history to newest first before lineage checks', async () => {
    const history = [
      {
        created_on: '2026-09-15T01:00:00.000Z',
        id: 'deployment-previous',
        versions: [{ percentage: 100, version_id: 'version-previous' }],
      },
      {
        created_on: '2026-09-15T01:01:00.000Z',
        id: 'deployment-staging',
        versions: [
          { percentage: 90, version_id: 'version-previous' },
          { percentage: 10, version_id: 'version-ours' },
        ],
      },
      {
        created_on: '2026-09-15T01:02:00.000Z',
        id: 'deployment-enabled',
        versions: [{ percentage: 100, version_id: 'version-ours' }],
      },
    ];
    const commands: Array<CloudflareOperation> = [];
    const deployments = await readPlatformWorkerDeployments(
      '/tmp/wrangler.json',
      'account',
      'void-api',
      async (args) => {
        commands.push(args);
        return { status: 0, stderr: '', stdout: '', data: history };
      },
    );

    expect(commands).toEqual([
      { type: 'deployments.list', configPath: '/tmp/wrangler.json', workerName: 'void-api' },
    ]);
    expect(deployments.map((deployment) => deployment.id)).toEqual([
      'deployment-enabled',
      'deployment-staging',
      'deployment-previous',
    ]);
    expect(
      classifyPlatformWorkerDeploymentLineage(deployments, 'version-ours', 'deployment-previous'),
    ).toEqual({ deploymentId: 'deployment-enabled', kind: 'intervening' });

    const raced = await readPlatformWorkerDeployments(
      '/tmp/wrangler.json',
      'account',
      'void-api',
      async () => ({
        status: 0,
        stderr: '',
        stdout: '',
        data: [
          ...history,
          {
            created_on: '2026-09-15T01:03:00.000Z',
            id: 'deployment-racer',
            versions: [{ percentage: 100, version_id: 'version-racer' }],
          },
        ],
      }),
    );
    expect(
      classifyPlatformWorkerDeploymentLineage(raced, 'version-ours', 'deployment-previous'),
    ).toEqual({ kind: 'concurrent-after' });
  });

  it('restores the exact prior traffic split with supported Wrangler version activation', async () => {
    const previous = {
      created_on: '2026-09-15T01:00:00.000Z',
      id: 'deployment-intervening',
      versions: [
        { percentage: 25, version_id: 'version-a' },
        { percentage: 75, version_id: 'version-b' },
      ],
    };
    const ours = {
      created_on: '2026-09-15T01:01:00.000Z',
      id: 'deployment-ours',
      versions: [{ percentage: 100, version_id: 'version-ours' }],
    };
    const commands: Array<CloudflareOperation> = [];
    let restored = false;
    await restorePlatformWorkerDeployment({
      accountId: 'account',
      configPath: '/tmp/wrangler.json',
      directory: '/tmp',
      expectedActiveDeploymentId: 'deployment-ours',
      expectedActiveVersionId: 'version-ours',
      restoration: {
        id: previous.id,
        versions: previous.versions.map((version) => ({
          percentage: version.percentage,
          versionId: version.version_id,
        })),
      },
      runner: async (args) => {
        commands.push(args);
        if (args.type === 'versions.deploy') {
          restored = true;
          return { status: 0, stderr: '', stdout: '', data: '' };
        }
        return {
          status: 0,
          stderr: '',
          stdout: '',
          data: restored
            ? [
                previous,
                ours,
                {
                  ...previous,
                  created_on: '2026-09-15T01:02:00.000Z',
                  id: 'deployment-restored',
                },
              ]
            : [previous, ours],
        };
      },
      workerName: 'void-api',
    });

    expect(commands[1]).toEqual({
      type: 'versions.deploy',
      configPath: '/tmp/wrangler.json',
      versions: [
        { versionId: 'version-a', percentage: 25 },
        { versionId: 'version-b', percentage: 75 },
      ],
      message: 'Void platform restoration deployment-intervening',
      bypassDeploymentChecks: true,
    });
    expect(commands.some((args) => args.type.endsWith('.delete'))).toBe(false);
  });

  it('does not restore over a known newer deployment', async () => {
    const commands: Array<CloudflareOperation> = [];
    await expect(
      restorePlatformWorkerDeployment({
        accountId: 'account',
        configPath: '/tmp/wrangler.json',
        directory: '/tmp',
        expectedActiveDeploymentId: 'deployment-ours',
        expectedActiveVersionId: 'version-ours',
        restoration: {
          id: 'deployment-intervening',
          versions: [{ percentage: 100, versionId: 'version-intervening' }],
        },
        runner: async (args) => {
          commands.push(args);
          return {
            status: 0,
            stderr: '',
            stdout: '',
            data: [
              {
                created_on: '2026-09-15T01:00:00.000Z',
                id: 'deployment-intervening',
                versions: [{ percentage: 100, version_id: 'version-intervening' }],
              },
              {
                created_on: '2026-09-15T01:01:00.000Z',
                id: 'deployment-ours',
                versions: [{ percentage: 100, version_id: 'version-ours' }],
              },
              {
                created_on: '2026-09-15T01:02:00.000Z',
                id: 'deployment-newer',
                versions: [{ percentage: 100, version_id: 'version-newer' }],
              },
            ],
          };
        },
        workerName: 'void-api',
      }),
    ).rejects.toThrow('refusing to overwrite the newer deployment');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toEqual('deployments.list');
  });

  it('stops when restoration is superseded without attempting another mutation', async () => {
    const previous = {
      created_on: '2026-09-15T01:00:00.000Z',
      id: 'deployment-previous',
      versions: [{ percentage: 100, version_id: 'version-previous' }],
    };
    const ours = {
      created_on: '2026-09-15T01:01:00.000Z',
      id: 'deployment-ours',
      versions: [{ percentage: 100, version_id: 'version-ours' }],
    };
    const commands: Array<CloudflareOperation> = [];
    let activationAttempted = false;
    await expect(
      restorePlatformWorkerDeployment({
        accountId: 'account',
        configPath: '/tmp/wrangler.json',
        directory: '/tmp',
        expectedActiveDeploymentId: 'deployment-ours',
        expectedActiveVersionId: 'version-ours',
        restoration: {
          id: 'deployment-previous',
          versions: [{ percentage: 100, versionId: 'version-previous' }],
        },
        runner: async (args) => {
          commands.push(args);
          if (args.type === 'versions.deploy') {
            activationAttempted = true;
            return { status: 0, stderr: '', stdout: '', data: '' };
          }
          return {
            status: 0,
            stderr: '',
            stdout: '',
            data: activationAttempted
              ? [
                  previous,
                  ours,
                  {
                    created_on: '2026-09-15T01:02:00.000Z',
                    id: 'deployment-newer',
                    versions: [{ percentage: 100, version_id: 'version-newer' }],
                  },
                ]
              : [previous, ours],
          };
        },
        workerName: 'void-api',
      }),
    ).rejects.toThrow('restoration was superseded');

    expect(commands.filter((args) => args.type === 'versions.deploy')).toHaveLength(1);
    expect(commands.some((args) => args.type.endsWith('.delete'))).toBe(false);
  });

  it('binds an existing Worker snapshot to its immutable ownership marker', async () => {
    const versionId = '11111111-1111-4111-8111-111111111111';
    const marker = '{"installationId":"ours"}';
    const triggerConfig = {
      crons: [],
      preview_urls: true,
      queueConsumers: [],
      routes: [],
      workers_dev: true,
      workflows: [],
    };
    const runner = async (args: CloudflareOperation) => ({
      status: 0,
      stderr: '',
      stdout: '',
      data:
        args.type === 'deployments.status'
          ? { versions: [{ percentage: 100, version_id: versionId }] }
          : {
              annotations: {
                'workers/message': encodeCloudflareVersionMessage([], triggerConfig),
              },
              script: { migration_tag: 'v4' },
              resources: {
                bindings: [{ name: 'PLATFORM_OWNERSHIP_MARKER', type: 'plain_text', text: marker }],
              },
            },
    });

    await expect(
      readActivePlatformWorkerSnapshot('wrangler.json', 'account', 'worker', marker, runner),
    ).resolves.toEqual({ migrationTag: 'v4', triggerConfig, versionId });
    await expect(
      readActivePlatformWorkerSnapshot(
        'wrangler.json',
        'account',
        'worker',
        '{"installationId":"replacement"}',
        runner,
      ),
    ).rejects.toThrow('does not belong to this installation');
  });

  it('omits completed Durable Object migrations without rewriting earlier history', () => {
    const migrations = [
      { tag: 'v1', new_sqlite_classes: ['UsageCounter'] },
      { tag: 'v2', new_sqlite_classes: ['CronScheduler'] },
      { tag: 'v3', new_sqlite_classes: ['ErrorAlertMonitor'] },
      { tag: 'v4', new_sqlite_classes: ['SandboxConcurrencyCounter'] },
    ];
    const config = { migrations, name: 'void-api' };

    expect(withoutCompletedPlatformWorkerMigrations(config, 'v4')).toEqual({ name: 'void-api' });
    expect(withoutCompletedPlatformWorkerMigrations(config, 'v3')).toBe(config);
    expect(withoutCompletedPlatformWorkerMigrations(config, null)).toBe(config);
    expect(config.migrations).toBe(migrations);
  });

  it('reuses a Worker upload digest only for identical code, assets, and bindings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-worker-fingerprint-'));
    try {
      const main = join(directory, 'worker.js');
      const assets = join(directory, 'assets');
      mkdirSync(assets);
      writeFileSync(main, 'export default { fetch() { return new Response("one"); } };');
      writeFileSync(join(assets, 'index.html'), '<h1>one</h1>');
      const config = {
        main,
        name: 'void-test-api',
        assets: { directory: assets },
        vars: { PLATFORM_VERSION: 'one' },
      };
      const original = platformWorkerUploadFingerprint(config);
      expect(original).toMatch(/^[a-f0-9]{64}$/);
      expect(platformWorkerUploadFingerprint(config)).toBe(original);
      expect(platformWorkerUploadFingerprint(config, ['example.com/*'])).not.toBe(original);
      const sourceMap = join(directory, 'worker.js.map');
      writeFileSync(sourceMap, '{"sources":["worker.ts"]}');
      expect(platformWorkerUploadFingerprint(config)).toBe(original);
      rmSync(sourceMap);
      expect(
        platformWorkerUploadFingerprint({ ...config, vars: { PLATFORM_VERSION: 'two' } }),
      ).not.toBe(original);
      writeFileSync(main, 'export default { fetch() { return new Response("two"); } };');
      expect(platformWorkerUploadFingerprint(config)).not.toBe(original);
      writeFileSync(main, 'export default { fetch() { return new Response("one"); } };');
      writeFileSync(join(assets, 'index.html'), '<h1>two</h1>');
      expect(platformWorkerUploadFingerprint(config)).not.toBe(original);
      expect(
        platformWorkerUploadFingerprint({ ...config, main: join(directory, 'missing.js') }),
      ).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a Worker replacement during immutable version inspection', async () => {
    const versions = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const runner = async (args: CloudflareOperation) => ({
      status: 0,
      stderr: '',
      stdout: '',
      data:
        args.type === 'deployments.status'
          ? { versions: [{ percentage: 100, version_id: versions.shift() }] }
          : {
              resources: {
                bindings: [{ name: 'PLATFORM_OWNERSHIP_MARKER', type: 'plain_text', text: 'ours' }],
              },
            },
    });

    await expect(
      readActivePlatformWorkerSnapshot('wrangler.json', 'account', 'worker', 'ours', runner),
    ).rejects.toThrow('changed concurrently');
  });

  it('preserves unmanaged Worker routes and custom domains across deploy and rollback', async () => {
    const plan = await examplePlan(null, { controlPlaneDomain: 'api.example.com' });
    const managedDispatchPattern = createApplicationRoutes(plan.deployment.application)[0]!.pattern;
    const client = {
      listWorkerDomains: async () => [
        {
          hostname: 'api.example.com',
          id: 'managed-api',
          service: plan.deployment.resources.apiWorker,
        },
        {
          hostname: 'admin.example.net',
          id: 'manual-api',
          service: plan.deployment.resources.apiWorker,
        },
        { hostname: 'other.example.net', id: 'other', service: 'unrelated-worker' },
      ],
      listWorkerServiceRoutes: async (_account: string, worker: string) =>
        worker === plan.deployment.resources.dispatchWorker
          ? [
              { pattern: managedDispatchPattern, zoneName: 'example.com' },
              { pattern: 'manual.example.net/*', zoneName: 'example.net' },
            ]
          : [],
    };

    const apiTraffic = await inventoryUnmanagedPlatformWorkerTraffic(
      client,
      plan,
      plan.deployment.resources.apiWorker,
    );
    expect(apiTraffic).toEqual([{ pattern: 'admin.example.net', custom_domain: true }]);
    const dispatchTraffic = await inventoryUnmanagedPlatformWorkerTraffic(
      client,
      plan,
      plan.deployment.resources.dispatchWorker,
    );
    expect(dispatchTraffic).toEqual([
      { pattern: 'manual.example.net/*', zone_name: 'example.net' },
    ]);

    const nextConfig = mergePlatformWorkerTrafficConfig(
      { routes: [{ pattern: managedDispatchPattern, zone_name: 'example.com' }] },
      dispatchTraffic,
    );
    expect(nextConfig.routes).toEqual([
      { pattern: managedDispatchPattern, zone_name: 'example.com' },
      { pattern: 'manual.example.net/*', zone_name: 'example.net' },
    ]);
    expect(
      mergePreservedTriggerRoutes(
        {
          crons: [],
          preview_urls: true,
          queueConsumers: [],
          routes: [{ pattern: managedDispatchPattern, zone_name: 'example.com' }],
          workers_dev: true,
          workflows: [],
        },
        dispatchTraffic,
      ).routes,
    ).toEqual(nextConfig.routes);

    expect(
      isolatePlatformWorkerCustomDomains({
        routes: [
          { pattern: 'api.example.com', custom_domain: true, zone_name: 'example.com' },
          { pattern: 'apps.example.com/*', zone_name: 'example.com' },
        ],
      }),
    ).toEqual({
      customDomains: [{ hostname: 'api.example.com', zoneName: 'example.com' }],
      wranglerConfig: {
        routes: [{ pattern: 'apps.example.com/*', zone_name: 'example.com' }],
      },
    });

    expect(
      withoutPlatformWorkerTrafficAttachments({
        name: 'void-dispatch',
        route: 'legacy.example.com/*',
        routes: [
          { pattern: 'apps.example.com/*', zone_name: 'example.com' },
          { pattern: 'manual.example.net/*', zone_name: 'example.net' },
        ],
      }),
    ).toEqual({ name: 'void-dispatch' });
  });

  it('requires the installation ownership marker before managing a new Worker', async () => {
    const manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const marker = createPlatformResourceOwnershipMarker({
      accountId: 'account',
      installationId: manifest.id,
      ownershipNonce: manifest.ownershipNonce,
      resourceId: 'void-example-api',
      resourceKey: 'api-worker',
      resourceKind: 'worker',
      resourceName: 'void-example-api',
    });
    const workerClient = {
      getWorkerPlainTextBindings: async () => ({
        PLATFORM_OWNERSHIP_MARKER: JSON.stringify(marker),
      }),
      listWorkerNames: async () => ['void-example-api'],
    };

    await expect(
      inspectNewPlatformWorker(workerClient, 'account', manifest, 'api-worker', 'void-example-api'),
    ).resolves.toBe('owned');

    workerClient.getWorkerPlainTextBindings = async () => ({
      PLATFORM_OWNERSHIP_MARKER: JSON.stringify({ ...marker, ownershipNonce: 'replacement' }),
    });
    await expect(
      inspectNewPlatformWorker(workerClient, 'account', manifest, 'api-worker', 'void-example-api'),
    ).rejects.toThrow('refusing to treat it as installer-owned');

    workerClient.listWorkerNames = async () => [];
    await expect(
      inspectNewPlatformWorker(workerClient, 'account', manifest, 'api-worker', 'void-example-api'),
    ).resolves.toBe('missing');
  });

  it('keeps disabled lifecycle traffic authoritative over stale Worker metadata', () => {
    const installed = {
      ...createPlatformInstallationManifest({
        account: { id: 'account', name: 'Account' },
        createdAt: '2026-09-14T00:00:00.000Z',
        deployment: createPlatformDeploymentManifest({
          application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
          displayName: 'Example',
          installationSlug: 'example',
        }),
        id: 'example-a1b2c3d4',
        ownershipNonce: '0123456789abcdef0123456789abcdef',
        platformVersion: '1.0.0',
      }),
      status: 'installed' as const,
    };
    const failedDisable = {
      ...setInstallationDesiredState(installed, 'disabled', '2026-09-14T00:00:02.000Z'),
      status: 'failed' as const,
    };
    expect(stablePublicEndpointState(failedDisable)).toBe(false);

    const interruptedFreshInstall = {
      ...installed,
      status: 'failed' as const,
    };
    expect(interruptedFreshInstall.desiredState).toBe('enabled');
    expect(stablePublicEndpointState(interruptedFreshInstall)).toBe(false);
    expect(stablePublicEndpointState(installed)).toBe(true);

    const previous = resolvePlatformPreviousTriggerConfig(
      {
        crons: ['0 * * * *'],
        preview_urls: true,
        queueConsumers: [{ queue: 'usage' }],
        routes: [{ pattern: 'api.example.com', custom_domain: true }],
        workers_dev: true,
        workflows: [{ name: 'maintenance' }],
      },
      {
        crons: ['new cron must not replace version state'],
        preview_urls: false,
        queueConsumers: [],
        routes: [],
        workers_dev: false,
        workflows: [],
      },
      false,
    );
    expect(previous).toEqual({
      crons: ['0 * * * *'],
      preview_urls: false,
      queueConsumers: [{ queue: 'usage' }],
      routes: [],
      workers_dev: false,
      workflows: [{ name: 'maintenance' }],
    });
  });

  it('verifies API, discovery, proxy, dispatch, and email gateway before committing a cutover', async () => {
    const requests: Array<{ headers: Headers; url: string; redirect?: RequestRedirect }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ headers: new Headers(init?.headers), url, redirect: init?.redirect });
      return Response.json(
        url.endsWith('/.well-known/void-platform') || url === 'https://email.example.com/health'
          ? {
              installationId: 'example-a1b2c3d4',
              platformVersion: '1.2.3',
              usageProtocolVersion: 1,
              emailProtocolVersion: 1,
            }
          : { ok: true },
      );
    }) as typeof fetch;

    await verifyPlatformHealth(
      'https://api.example.com',
      'example-a1b2c3d4',
      'https://proxy.example.com',
      'apps.example.com',
      '1.2.3',
      1,
      'probe-token',
      fetcher,
      undefined,
      { accountName: 'Example', workers: [], emailGatewayUrl: 'https://email.example.com' },
    );

    expect(requests.map((entry) => entry.url)).toEqual([
      'https://api.example.com/health',
      'https://api.example.com/.well-known/void-platform',
      'https://proxy.example.com/health',
      'https://void-platform-health.apps.example.com/health',
      'https://email.example.com/health',
    ]);
    expect(
      requests.every((entry) => entry.headers.get('X-Void-Platform-Probe') === 'probe-token'),
    ).toBe(true);
    expect(requests.every((entry) => !entry.headers.has('X-Health-Check'))).toBe(true);
    expect(requests.every((entry) => entry.redirect === 'manual')).toBe(true);
  });

  describe('shared email bootstrap progress', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('allows a durable bootstrap response to take longer than thirty seconds', async () => {
      vi.useFakeTimers();
      const timeouts = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), delay);
        return controller.signal;
      });
      const fetcher = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
            setTimeout(
              () => resolve(Response.json({ version: 1, state: 'ready', operationId: 'eop-slow' })),
              35_000,
            );
          }),
      );
      const result = bootstrapPlatformSharedEmail(
        'https://api.example.com',
        'probe-token',
        fetcher as typeof fetch,
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      await vi.advanceTimersByTimeAsync(35_000);

      expect(await result).toEqual({ value: 'eop-slow' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(timeouts).toHaveBeenCalledWith(120_000);
    });

    it('replays the same protected request after a timeout and polls its durable operation', async () => {
      vi.useFakeTimers();
      const fetcher = vi
        .fn()
        .mockRejectedValueOnce(new DOMException('untrusted-provider-secret', 'TimeoutError'))
        .mockResolvedValueOnce(
          Response.json(
            {
              version: 1,
              state: 'incomplete',
              operationId: 'eop-resume',
              operationStatus: 'running',
              currentStep: 'subaddressing_ensure',
              failureCode: null,
            },
            { status: 503 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({ version: 1, state: 'ready', operationId: 'eop-resume' }),
        );
      const result = bootstrapPlatformSharedEmail(
        'https://api.example.com',
        'probe-token',
        fetcher,
      );

      await vi.advanceTimersByTimeAsync(2_000);

      expect(await result).toBe('eop-resume');
      expect(fetcher).toHaveBeenCalledTimes(3);
      for (const [url, init] of fetcher.mock.calls) {
        expect(url).toBe('https://api.example.com/internal/platform/email-bootstrap');
        expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
        expect(new Headers(init.headers).get('X-Void-Platform-Probe')).toBe('probe-token');
      }
    });

    it('bounds repeated timeouts and reports the named bootstrap without provider details', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const timeouts = vi.spyOn(AbortSignal, 'timeout');
      const fetcher = vi.fn(async () => {
        vi.setSystemTime(Date.now() + timeouts.mock.calls.at(-1)![0]);
        throw new DOMException('untrusted-provider-secret', 'TimeoutError');
      });
      const result = bootstrapPlatformSharedEmail(
        'https://api.example.com',
        'probe-token',
        fetcher,
      ).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(2_000);

      const error = String(await result);
      expect(error).toContain('Shared email bootstrap did not finish within five minutes');
      expect(error).toContain('Traffic remains disabled');
      expect(error).toContain('repair or resume command');
      expect(error).not.toContain('untrusted-provider-secret');
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(timeouts.mock.calls.map(([delay]) => delay)).toEqual([120_000, 120_000, 58_000]);
    });

    it.each(['blocked', 'unknown', 'failed'])(
      'does not replay a terminal %s operation',
      async (operationStatus) => {
        const fetcher = vi.fn(async () =>
          Response.json(
            {
              version: 1,
              state: 'incomplete',
              operationId: 'eop-terminal',
              operationStatus,
              currentStep: 'subaddressing_ensure',
              failureCode: 'outcome_unknown',
            },
            { status: 503 },
          ),
        );

        const failure = bootstrapPlatformSharedEmail(
          'https://api.example.com',
          'probe-token',
          fetcher,
        );
        await expect(failure).rejects.toThrow(`Operation eop-terminal: ${operationStatus}`);
        await expect(failure).rejects.toThrow('Traffic remains disabled');
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    );

    it('rejects a changed durable operation identity while polling', async () => {
      vi.useFakeTimers();
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              version: 1,
              state: 'incomplete',
              operationId: 'eop-first',
              operationStatus: 'pending',
            },
            { status: 503 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({ version: 1, state: 'ready', operationId: 'eop-other' }),
        );
      const result = bootstrapPlatformSharedEmail(
        'https://api.example.com',
        'probe-token',
        fetcher,
      ).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(String(await result)).toContain('operation identity changed');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([
      { operationId: 'provider-secret\nAuthorization: Bearer private-value' },
      { operationId: 'eop-contradictory', operationStatus: 'blocked' },
      { operationId: 'eop-contradictory', operationStatus: 'unknown' },
      { operationId: 'eop-contradictory', operationStatus: 'pending' },
      { operationId: 'eop-contradictory', failureCode: 'outcome_unknown' },
    ])('rejects malformed or contradictory ready checkpoints: %j', async (fields) => {
      const fetcher = vi.fn(async () => Response.json({ version: 1, state: 'ready', ...fields }));

      const error = await bootstrapPlatformSharedEmail(
        'https://api.example.com',
        'probe-token',
        fetcher,
      ).catch((error: unknown) => error);

      expect(String(error)).toContain('did not reach inbound readiness');
      expect(String(error)).not.toContain('provider-secret');
      expect(String(error)).not.toContain('private-value');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it('reports safe shared-email routing prerequisites without exposing provider details', async () => {
    const fetcher = (failureDetail: string) =>
      (async () =>
        Response.json(
          {
            version: 1,
            state: 'incomplete',
            operationId: 'eop-blocked',
            operationStatus: 'blocked',
            currentStep: 'inbound_probe',
            failureCode: 'blocked',
            domain: 'mail.example.com',
            inboundStatus: 'needs_dns',
            failureDetail,
            providerError: 'secret-provider-token',
          },
          { status: 503 },
        )) as typeof fetch;
    const mxDetail =
      'MX records for mail.example.com do not route mail to Cloudflare Email Routing';
    await expect(
      bootstrapPlatformSharedEmail('https://api.example.com', 'probe-token', fetcher(mxDetail)),
    ).rejects.toThrow(
      'Step: inbound_probe. Failure: blocked. Domain: mail.example.com (inbound: needs_dns). MX records for mail.example.com do not route mail to Cloudflare Email Routing. Enable Email Routing for mail.example.com in the Cloudflare dashboard, then resume this installation.',
    );
    try {
      await bootstrapPlatformSharedEmail(
        'https://api.example.com',
        'probe-token',
        fetcher('provider rejected Bearer secret-provider-token'),
      );
      throw new Error('Expected readiness failure');
    } catch (error) {
      expect(String(error)).toContain('Step: inbound_probe');
      expect(String(error)).not.toContain('secret-provider-token');
      expect(String(error)).not.toContain('provider rejected');
      expect(String(error)).not.toContain('Enable Email Routing');
    }
  });

  describe('shared email permission hints', () => {
    const blocked = (fields: Record<string, unknown>) =>
      (async () =>
        Response.json(
          {
            version: 1,
            state: 'incomplete',
            operationId: 'eop-blocked',
            operationStatus: 'blocked',
            failureCode: 'blocked',
            domain: 'mail.example.com',
            inboundStatus: 'pending',
            failureDetail: 'Cloudflare API error: Authentication error (HTTP 403)',
            ...fields,
          },
          { status: 503 },
        )) as typeof fetch;
    const failure = (fields: Record<string, unknown>) =>
      bootstrapPlatformSharedEmail('https://api.example.com', 'probe-token', blocked(fields)).then(
        () => {
          throw new Error('Expected readiness failure');
        },
        String,
      );

    it.each([
      ['routing_enable', 'Zone → Zone Settings → Edit'],
      ['subaddressing_ensure', 'Zone → Zone Settings → Edit'],
      ['inbound_probe', 'Zone → Zone Settings → Edit'],
      ['sending_onboard', 'Account → Email Sending → Edit'],
    ])('names the runtime-token permission for a blocked %s step', async (step, permission) => {
      const message = await failure({ currentStep: step });

      expect(message).toContain(
        `Step: ${step}. Failure: blocked. Domain: mail.example.com (inbound: pending). This step needs ${permission} on the runtime API token.`,
      );
      expect(message).toContain('The token value stays the same.');
      expect(message).toContain('VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN');
      expect(message).toMatch(/Then resume this installation\. Traffic remains disabled\.$/);
      expect(message).not.toContain('Authentication error');
    });

    it('names a permission only for a refused step that uses one', async () => {
      expect(await failure({ currentStep: 'routing_enable' })).toContain('runtime API token');

      for (const fields of [
        // An uncertain outcome is not a refusal.
        { currentStep: 'routing_enable', failureCode: 'outcome_unknown' },
        // The step does not call Cloudflare.
        { currentStep: 'publish' },
        // An inherited object key is not a step.
        { currentStep: 'constructor' },
        // A known routing prerequisite already explains the failure.
        {
          currentStep: 'inbound_probe',
          failureDetail: 'zone catch-all does not point to this ingress',
        },
      ]) {
        const message = await failure(fields);
        expect(message).toContain('Traffic remains disabled');
        expect(message).not.toContain('runtime API token');
      }
    });
  });

  it.each([
    'https://api.example.com/health',
    'https://api.example.com/.well-known/void-platform',
    'https://proxy.example.com/health',
    'https://void-example-dispatch.account.workers.dev/health',
  ])(
    'explains Cloudflare account Default-Deny at %s without exposing response content',
    async (blockedUrl) => {
      process.env.CF_ACCESS_CLIENT_ID = 'unrelated-service-id';
      process.env.CF_ACCESS_CLIENT_SECRET = 'unrelated-service-secret';
      const requests: Array<Headers> = [];
      const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push(new Headers(init?.headers));
        if (url === blockedUrl) {
          return new Response(
            '<title>Blocked by this account&#39;s &#60;strong&#62;Default-Deny&#60;/strong&#62; policy.</title><script>var b={errorCode: 1050};</script>untrusted-response-content',
            {
              status: 403,
              headers: { server: 'cloudflare', 'content-type': 'text/html; charset=UTF-8' },
            },
          );
        }
        return Response.json(
          url.endsWith('/.well-known/void-platform')
            ? {
                installationId: 'example-a1b2c3d4',
                platformVersion: '1.2.3',
                usageProtocolVersion: 1,
              }
            : { ok: true },
        );
      }) as typeof fetch;
      const failure = await verifyPlatformHealth(
        'https://api.example.com',
        'example-a1b2c3d4',
        'https://proxy.example.com',
        'account.workers.dev',
        '1.2.3',
        1,
        'probe-token',
        fetcher,
        'https://void-example-dispatch.account.workers.dev',
        {
          accountName: 'Example account',
          workers: ['legacy-api-123', 'custom-proxy', 'custom-dispatch'],
          resumeCommand: 'void-dev platform install --resume --name example-a1b2c3d4',
        },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = String(failure);
      expect(message).toContain(new URL(blockedUrl).origin);
      expect(message).toContain('Cloudflare Access blocked the platform health checks');
      expect(message).toContain('error 1050');
      expect(message).toContain('account "Example account"');
      expect(message).toContain('legacy-api-123, custom-proxy, custom-dispatch');
      expect(message).toContain('void-dev platform install --resume --name example-a1b2c3d4');
      expect(message).not.toContain('untrusted-response-content');
      expect(message).not.toContain('probe-token');
      expect(message).not.toContain('https://test.account.workers.dev');
      expect(
        requests.every(
          (headers) =>
            !headers.has('CF-Access-Client-Id') && !headers.has('CF-Access-Client-Secret'),
        ),
      ).toBe(true);
    },
  );

  it.each([
    {
      status: 403,
      headers: new Headers({ server: 'cloudflare', 'content-type': 'application/json' }),
      body: '{"error":"Forbidden"}',
    },
    {
      status: 403,
      headers: new Headers({ server: 'cloudflare', 'content-type': 'text/html' }),
      body: '<title>Other firewall block</title>',
    },
    { status: 302, headers: new Headers({ location: 'https://login.example.com' }), body: '' },
  ])(
    'does not misdiagnose other failed probes as Default-Deny: $status',
    async ({ status, headers, body }) => {
      const fetcher = (async () => new Response(body, { status, headers })) as typeof fetch;
      await expect(
        verifyPlatformHealth(
          'https://api.example.com',
          'example-a1b2c3d4',
          'https://proxy.example.com',
          'apps.example.com',
          '1.2.3',
          1,
          'probe-token',
          fetcher,
        ),
      ).rejects.toEqual(
        new Error(
          `platform: Health check failed at https://api.example.com/health (HTTP ${status}).`,
        ),
      );
    },
  );

  it('authenticates lifecycle health probes with explicitly scoped Access proof', async () => {
    process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify(
      Object.fromEntries(
        [
          'https://api.staging.void.cloud',
          'https://proxy.staging.void.cloud',
          'https://void-platform-health.staging.void.app',
        ].map((origin) => [
          origin,
          { CF_ACCESS_CLIENT_ID: 'service-id', CF_ACCESS_CLIENT_SECRET: 'service-secret' },
        ]),
      ),
    );
    process.env.CF_ACCESS_CLIENT_ID = 'service-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'service-secret';
    const requests: Array<Headers> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Headers(init?.headers));
      return Response.json(
        String(input).endsWith('/.well-known/void-platform')
          ? {
              installationId: 'example-a1b2c3d4',
              platformVersion: '1.2.3',
              usageProtocolVersion: 1,
            }
          : { ok: true },
      );
    }) as typeof fetch;

    await verifyPlatformHealth(
      'https://api.staging.void.cloud',
      'example-a1b2c3d4',
      'https://proxy.staging.void.cloud',
      'staging.void.app',
      '1.2.3',
      1,
      'probe-token',
      fetcher,
    );

    expect(
      requests.every(
        (headers) =>
          headers.get('CF-Access-Client-Id') === 'service-id' &&
          headers.get('CF-Access-Client-Secret') === 'service-secret',
      ),
    ).toBe(true);
  });

  it('requires the live API to report the target usage protocol before traffic opens', async () => {
    const legacyFetcher = (async (input: string | URL | Request) =>
      Response.json(
        String(input).endsWith('/.well-known/void-platform')
          ? { installationId: 'example-a1b2c3d4', platformVersion: '1.2.3' }
          : { ok: true },
      )) as typeof fetch;

    await verifyPlatformHealth(
      'https://api.example.com',
      'example-a1b2c3d4',
      'https://proxy.example.com',
      'apps.example.com',
      '1.2.3',
      0,
      'probe-token',
      legacyFetcher,
    );
    await expect(
      verifyPlatformHealth(
        'https://api.example.com',
        'example-a1b2c3d4',
        'https://proxy.example.com',
        'apps.example.com',
        '1.2.3',
        1,
        'probe-token',
        legacyFetcher,
      ),
    ).rejects.toThrow('usage protocol does not match');
  });

  it('trusts only a valid DB-backed sandbox drain protocol v1 response', async () => {
    const statuses = [
      {
        complete: false,
        generation: null,
        phase: null,
        state: 'required',
        updatedAt: null,
        version: 1,
      },
      {
        complete: true,
        generation: 'generation-1',
        phase: 'resources',
        state: 'complete',
        updatedAt: '2026-09-16T00:00:00.000Z',
        version: 1,
      },
    ];
    const headers: Array<Headers> = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return Response.json(statuses.shift());
    }) as typeof fetch;

    await expect(
      verifyPlatformSandboxDrain('https://api.example.com', 'probe-token', fetcher),
    ).resolves.toBe(false);
    await expect(
      verifyPlatformSandboxDrain('https://api.example.com', 'probe-token', fetcher),
    ).resolves.toBe(true);
    expect(headers.every((value) => value.get('X-Void-Platform-Probe') === 'probe-token')).toBe(
      true,
    );

    await expect(
      verifyPlatformSandboxDrain('https://api.example.com', 'probe-token', (async () =>
        Response.json({
          complete: true,
          generation: null,
          phase: null,
          state: 'complete',
          updatedAt: null,
          version: 1,
        })) as typeof fetch),
    ).rejects.toThrow('invalid DB-backed protocol v1');
    await expect(
      verifyPlatformSandboxDrain('https://api.example.com', 'probe-token', (async () =>
        Response.json({ error: 'invalid' }, { status: 503 })) as typeof fetch),
    ).rejects.toThrow('Traffic remains disabled');
  });

  it('derives an installation-specific high-entropy health probe token', () => {
    const first = createPlatformHealthProbeToken('a'.repeat(43));
    const second = createPlatformHealthProbeToken('b'.repeat(43));
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('a'.repeat(20));
  });

  it('rejects a cutover when the proxy is unhealthy', async () => {
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://proxy.example.com/health') {
        return new Response('unhealthy', { status: 500 });
      }
      return Response.json(
        url.endsWith('/.well-known/void-platform')
          ? {
              installationId: 'example-a1b2c3d4',
              platformVersion: '1.2.3',
              usageProtocolVersion: 1,
            }
          : { ok: true },
      );
    }) as typeof fetch;

    await expect(
      verifyPlatformHealth(
        'https://api.example.com',
        'example-a1b2c3d4',
        'https://proxy.example.com',
        'apps.example.com',
        '1.2.3',
        1,
        'probe-token',
        fetcher,
      ),
    ).rejects.toThrow('Proxy health check failed');
  });

  it.each([
    { failure: 'unavailable', status: 503, body: {} },
    { failure: 'foreign installation', status: 200, body: { installationId: 'other' } },
    { failure: 'stale version', status: 200, body: { platformVersion: '1.2.2' } },
    { failure: 'unsupported protocol', status: 200, body: { emailProtocolVersion: 2 } },
  ])('rejects an email gateway that is $failure before cutover', async ({ status, body }) => {
    const identity = {
      installationId: 'example-a1b2c3d4',
      platformVersion: '1.2.3',
      usageProtocolVersion: 1,
      emailProtocolVersion: 1,
    };
    const fetcher = (async (input: string | URL | Request) =>
      String(input) === 'https://email.example.com/health'
        ? Response.json({ ...identity, ...body }, { status })
        : Response.json(identity)) as typeof fetch;
    await expect(
      verifyPlatformHealth(
        'https://api.example.com',
        identity.installationId,
        'https://proxy.example.com',
        'apps.example.com',
        identity.platformVersion,
        1,
        'probe-token',
        fetcher,
        undefined,
        { accountName: 'Example', workers: [], emailGatewayUrl: 'https://email.example.com' },
      ),
    ).rejects.toThrow(/email gateway/i);
  });

  it('requires live PostgreSQL migration history to be an exact package prefix', async () => {
    const database = readPlatformRuntimeManifest().database;
    const first = database.migrations[0]!;
    const second = database.migrations[1]!;
    const connection = migrationConnection([
      { created_at: first.timestampMillis, hash: first.sha256, id: 1 },
      { created_at: second.timestampMillis, hash: second.sha256, id: 2 },
    ]);

    const state = await inspectPlatformDatabaseStateConnection(connection, database);
    expect(state.schemaDigest).toBe(
      platformDatabaseSchemaDigest(database.lineage, database.migrations.slice(0, 2)),
    );
    expect(state.pendingMigrations).toEqual(database.migrations.slice(2));

    connection.rows[1] = { ...connection.rows[1]!, hash: '0'.repeat(64) };
    await expect(inspectPlatformDatabaseStateConnection(connection, database)).rejects.toThrow(
      'not an exact prefix',
    );

    connection.rows[1] = {
      ...connection.rows[1]!,
      created_at: first.timestampMillis,
      hash: second.sha256,
    };
    await expect(inspectPlatformDatabaseStateConnection(connection, database)).rejects.toThrow(
      'duplicated or not strictly ordered',
    );
  });

  it('applies a fresh database transactionally without a rollback edge', async () => {
    const database = migrationSubset(2);
    const connection = migrationConnection();

    const result = await preparePlatformDatabaseConnection(
      connection,
      getPlatformRuntimeDirectory(),
      database,
      null,
      false,
    );

    expect(result).toEqual({
      appliedMigrations: 2,
      previousSchemaDigest: platformDatabaseSchemaDigest(database.lineage, []),
      schemaDigest: database.schemaDigest,
    });
    expect(connection.rows).toEqual(
      database.migrations.map((migration, index) => ({
        created_at: migration.timestampMillis,
        hash: migration.sha256,
        id: index + 1,
      })),
    );
    expect(connection.queries).toContain('BEGIN');
    expect(connection.queries).toContain('COMMIT');
    expect(connection.queries).not.toContain('ROLLBACK');
  });

  it.each([
    {
      sourceVersion: '0.22.0',
      rejectedVersion: '0.21.9',
      lastTag: '0055_durable_deployment_execution',
      sql: 'CREATE TRIGGER "void_shared_email_recipient_teardown_guard"',
    },
    ...['0.23.0', '0.24.0'].map((sourceVersion) => ({
      sourceVersion,
      rejectedVersion: '0.22.0',
      lastTag: '0056_email_shared_recipients',
      sql: '"authorized_by_user_id" SET NOT NULL',
    })),
    ...['0.25.0', '0.26.0'].map((sourceVersion) => ({
      sourceVersion,
      rejectedVersion: '0.24.0',
      lastTag: '0057_github_authority_constraints',
      sql: 'ADD COLUMN "proxy_token_gen"',
    })),
  ])(
    'upgrades a $sourceVersion installation and refuses an unreviewed $rejectedVersion one',
    async ({ sourceVersion, rejectedVersion, lastTag, sql }) => {
      const database = readPlatformRuntimeManifest().database;
      const baseline = database.migrations.slice(
        0,
        database.migrations.findIndex((migration) => migration.tag === lastTag) + 1,
      );
      expect(baseline.at(-1)?.tag).toBe(lastTag);
      const rows = baseline.map((migration, index) => ({
        id: index + 1,
        hash: migration.sha256,
        created_at: migration.timestampMillis,
      }));
      const rejected = migrationConnection(rows);
      await expect(
        preparePlatformDatabaseConnection(
          rejected,
          getPlatformRuntimeDirectory(),
          database,
          rejectedVersion,
          true,
        ),
      ).rejects.toThrow('cannot safely roll back');
      expect(rejected.queries).not.toContain('BEGIN');
      const accepted = migrationConnection(rows);
      const result = await preparePlatformDatabaseConnection(
        accepted,
        getPlatformRuntimeDirectory(),
        database,
        sourceVersion,
        true,
      );
      expect(result.appliedMigrations).toBe(database.migrations.length - baseline.length);
      expect(accepted.queries.some((query) => query.includes(sql))).toBe(true);
      expect(accepted.rows).toHaveLength(database.migrations.length);
    },
  );

  it('requires an exact rollback compatibility edge before an existing install migrates', async () => {
    const base = migrationSubset(1);
    const sourceDigest = platformDatabaseSchemaDigest(base.lineage, []);
    const connection = migrationConnection();

    await expect(
      preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        base,
        '0.10.13',
        true,
      ),
    ).rejects.toThrow('cannot safely roll back');
    expect(connection.queries).not.toContain('BEGIN');

    const compatible = {
      ...base,
      rollbackSafeFrom: [{ platformVersion: '0.10.13', schemaDigest: sourceDigest }],
    } satisfies PlatformRuntimeDatabaseManifest;
    await expect(
      preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        compatible,
        '0.10.13',
        true,
      ),
    ).resolves.toMatchObject({ appliedMigrations: 1, schemaDigest: compatible.schemaDigest });
  });

  it('rolls back every pending migration when one statement fails', async () => {
    const database = migrationSubset(2);
    const connection = migrationConnection([], 'CREATE TABLE "oauth_accounts"');

    await expect(
      preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        database,
        null,
        false,
      ),
    ).rejects.toThrow('migration failed');
    expect(connection.queries).toContain('ROLLBACK');
    expect(connection.queries).not.toContain('COMMIT');
    expect(connection.rows).toEqual([]);
  });

  it.each([
    { empty: true, expected: 'complete', phase: 'resources', state: 'complete' },
    { empty: false, expected: 'pending', phase: 'deployments', state: 'draining' },
  ] as const)(
    'establishes a $state sandbox drain checkpoint when database inventory empty=$empty',
    async ({ empty, expected, phase, state }) => {
      let checkpoint: Record<string, unknown> | undefined;
      const inserts: Array<ReadonlyArray<unknown> | undefined> = [];
      const checkpointReads: Array<string> = [];
      const connection = {
        query: async <Row extends Record<string, unknown>>(
          sql: string,
          values?: ReadonlyArray<unknown>,
        ) => {
          if (sql.includes('to_regclass')) {
            return {
              rows: [{ relation: 'sandbox_drain_checkpoints' }] as unknown as ReadonlyArray<Row>,
            };
          }
          if (sql.includes('FROM "sandbox_drain_checkpoints"')) {
            checkpointReads.push(sql);
            return {
              rows: (checkpoint ? [checkpoint] : []) as unknown as ReadonlyArray<Row>,
            };
          }
          if (sql.includes('NOT EXISTS(SELECT 1 FROM "deployments"')) {
            return { rows: [{ empty }] as unknown as ReadonlyArray<Row> };
          }
          if (sql.includes('INSERT INTO "sandbox_drain_checkpoints"')) {
            inserts.push(values);
            checkpoint = {
              admission_protocol: 0,
              completed_at: empty ? '2026-09-16T00:00:00.000Z' : null,
              cursor: { pass: empty ? '2' : '1' },
              generation: values?.[0],
              phase: values?.[2],
              started_at: '2026-09-16T00:00:00.000Z',
              state: values?.[1],
              updated_at: '2026-09-16T00:00:00.000Z',
            };
          }
          return { rows: [] as ReadonlyArray<Row> };
        },
      };

      const prepared = await preparePlatformSandboxDrainConnection(connection);
      expect(prepared.state).toBe(expected);
      expect(prepared.admissionProtocol).toBe(0);
      expect(prepared).toEqual({
        admissionProtocol: 0,
        generation: expect.stringMatching(/^[0-9a-f-]{36}$/),
        state: expected,
      });
      expect(inserts).toHaveLength(1);
      expect(inserts[0]?.slice(1)).toEqual([
        state,
        phase,
        JSON.stringify({ pass: empty ? '2' : '1' }),
      ]);
      expect(checkpointReads).toEqual([
        expect.stringContaining('0 AS "admission_protocol"'),
        expect.stringContaining('0 AS "admission_protocol"'),
      ]);
    },
  );

  it('requires the database admission column before arming protocol v2', async () => {
    const queries: Array<string> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        queries.push(sql);
        if (sql.includes('to_regclass')) {
          return {
            rows: [{ relation: 'sandbox_drain_checkpoints' }] as unknown as ReadonlyArray<Row>,
          };
        }
        if (sql.includes('information_schema.columns')) {
          return { rows: [{ present: false }] as unknown as ReadonlyArray<Row> };
        }
        return { rows: [] as ReadonlyArray<Row> };
      },
    };

    await expect(preparePlatformSandboxDrainConnection(connection, 2)).rejects.toThrow(
      'database does not include the sandbox deployment admission barrier',
    );
    expect(queries).not.toContain('BEGIN');
  });

  it('arms deployment admission before accepting an empty legacy drain inventory', async () => {
    let checkpoint: Record<string, unknown> = {
      admission_protocol: 0,
      completed_at: '2026-09-16T00:00:00.000Z',
      cursor: { pass: '2' },
      generation: 'pre-fence-generation',
      phase: 'resources',
      started_at: '2026-09-16T00:00:00.000Z',
      state: 'complete',
      updated_at: '2026-09-16T00:00:00.000Z',
    };
    const events: Array<string> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: ReadonlyArray<unknown>,
      ) => {
        if (sql.includes('to_regclass')) {
          return {
            rows: [{ relation: 'sandbox_drain_checkpoints' }] as unknown as ReadonlyArray<Row>,
          };
        }
        if (sql.includes('information_schema.columns')) {
          return { rows: [{ present: true }] as unknown as ReadonlyArray<Row> };
        }
        if (sql === 'BEGIN') {
          events.push('transaction:begin');
        } else if (sql.includes('LOCK TABLE "deployments" IN SHARE MODE')) {
          events.push('deployments:locked');
        } else if (sql === 'COMMIT') {
          events.push('transaction:commit');
        }
        if (sql.includes('FROM "sandbox_drain_checkpoints"') && sql.includes('SELECT')) {
          return { rows: [checkpoint] as unknown as ReadonlyArray<Row> };
        }
        if (sql.includes('INSERT INTO "sandbox_drain_checkpoints"')) {
          events.push('admission:armed');
          checkpoint = {
            ...checkpoint,
            admission_protocol: 2,
            completed_at: null,
            cursor: { pass: '1' },
            generation: values?.[0],
            phase: 'deployments',
            state: 'draining',
          };
        } else if (sql.includes('NOT EXISTS(SELECT 1 FROM "deployments"')) {
          events.push('inventory:empty');
          return { rows: [{ empty: true }] as unknown as ReadonlyArray<Row> };
        } else if (sql.includes('SET "state" = \'complete\'')) {
          events.push('checkpoint:complete');
          checkpoint = {
            ...checkpoint,
            completed_at: '2026-09-16T00:01:00.000Z',
            cursor: { pass: '2' },
            phase: 'resources',
            state: 'complete',
          };
        }
        return { rows: [] as ReadonlyArray<Row> };
      },
    };

    const prepared = await preparePlatformSandboxDrainConnection(connection, 2);
    expect(events).toEqual([
      'transaction:begin',
      'deployments:locked',
      'admission:armed',
      'inventory:empty',
      'checkpoint:complete',
      'transaction:commit',
    ]);
    expect(prepared).toMatchObject({
      admissionProtocol: 2,
      generation: expect.not.stringMatching(/^pre-fence/),
      state: 'complete',
    });
  });

  it('rolls back deployment admission arming when inventory cannot be read', async () => {
    const events: Array<string> = [];
    const checkpoint = {
      admission_protocol: 0,
      completed_at: null,
      cursor: { pass: '1' },
      generation: 'pre-fence-generation',
      phase: 'deployments',
      started_at: '2026-09-16T00:00:00.000Z',
      state: 'draining',
      updated_at: '2026-09-16T00:00:00.000Z',
    };
    const connection = {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        if (sql.includes('to_regclass')) {
          return {
            rows: [{ relation: 'sandbox_drain_checkpoints' }] as unknown as ReadonlyArray<Row>,
          };
        }
        if (sql.includes('information_schema.columns')) {
          return { rows: [{ present: true }] as unknown as ReadonlyArray<Row> };
        }
        if (sql.includes('FROM "sandbox_drain_checkpoints"') && sql.includes('SELECT')) {
          return { rows: [checkpoint] as unknown as ReadonlyArray<Row> };
        }
        if (sql === 'BEGIN') {
          events.push('transaction:begin');
        } else if (sql.includes('LOCK TABLE "deployments" IN SHARE MODE')) {
          events.push('deployments:locked');
        } else if (sql.includes('INSERT INTO "sandbox_drain_checkpoints"')) {
          events.push('admission:armed');
        } else if (sql.includes('NOT EXISTS(SELECT 1 FROM "deployments"')) {
          events.push('inventory:error');
          throw new Error('inventory unavailable');
        } else if (sql === 'ROLLBACK') {
          events.push('transaction:rollback');
        }
        return { rows: [] as ReadonlyArray<Row> };
      },
    };

    await expect(preparePlatformSandboxDrainConnection(connection, 2)).rejects.toThrow(
      'inventory unavailable',
    );
    expect(events).toEqual([
      'transaction:begin',
      'deployments:locked',
      'admission:armed',
      'inventory:error',
      'transaction:rollback',
    ]);
  });

  it('serializes lifecycle changes with the claimed PostgreSQL database', async () => {
    const queries: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: ReadonlyArray<unknown>,
      ) => {
        queries.push({ sql, values });
        if (sql.includes('FROM "__void_platform_installation"')) {
          return {
            rows: [
              { installation_id: 'install-one', ownership_nonce: 'nonce-one' },
            ] as unknown as ReadonlyArray<Row>,
          };
        }
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] as unknown as ReadonlyArray<Row> };
        }
        return { rows: [] as ReadonlyArray<Row> };
      },
    };
    const release = await acquirePlatformDatabaseLifecycleLockConnection(
      connection,
      'install-one',
      'nonce-one',
    );
    await release();
    await release();

    expect(queries.filter(({ sql }) => sql.includes('pg_try_advisory_lock'))).toHaveLength(1);
    expect(queries.filter(({ sql }) => sql.includes('pg_advisory_unlock'))).toHaveLength(1);
    expect(queries.find(({ sql }) => sql.includes('pg_try_advisory_lock'))?.values).toEqual([
      'void-platform-lifecycle-v1:install-one:nonce-one',
    ]);
  });

  it('reads and validates the authoritative lifecycle checkpoint without mutating it', async () => {
    const ownershipNonce = '0123456789abcdef0123456789abcdef';
    const manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'install-one',
      ownershipNonce,
      platformVersion: '1.0.0',
    });
    const queries: Array<string> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        queries.push(sql);
        if (sql.includes('to_regclass')) {
          return {
            rows: [{ relation: '__void_platform_installation' }] as unknown as ReadonlyArray<Row>,
          };
        }
        return {
          rows: [
            {
              installation_id: 'install-one',
              lifecycle_manifest: manifest,
              ownership_nonce: ownershipNonce,
            },
          ] as unknown as ReadonlyArray<Row>,
        };
      },
    };

    await expect(
      readPlatformDatabaseLifecycleManifestConnection(connection, 'install-one', ownershipNonce),
    ).resolves.toEqual(manifest);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/^SELECT/);
  });

  it('treats a missing database ownership table as an unclaimed install', async () => {
    const queries: Array<string> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        queries.push(sql);
        return { rows: [{ relation: null }] as unknown as ReadonlyArray<Row> };
      },
    };

    await expect(
      readPlatformDatabaseLifecycleManifestConnection(
        connection,
        'install-one',
        '0123456789abcdef0123456789abcdef',
      ),
    ).resolves.toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('to_regclass');
  });

  it('reads and writes authoritative lifecycle state while holding the database lock', async () => {
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'install-one',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = transitionInstallation(manifest, 'planned', '2026-09-14T00:00:01.000Z');
    const queries: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: ReadonlyArray<unknown>,
      ) => {
        queries.push({ sql, values });
        if (sql.includes('FROM "__void_platform_installation"')) {
          return {
            rows: [
              {
                installation_id: manifest.id,
                lifecycle_manifest: manifest,
                ownership_nonce: manifest.ownershipNonce,
              },
            ] as unknown as ReadonlyArray<Row>,
          };
        }
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] as unknown as ReadonlyArray<Row> };
        }
        if (sql.includes('UPDATE "__void_platform_installation"')) {
          return { rows: [{ singleton: true }] as unknown as ReadonlyArray<Row> };
        }
        return { rows: [] as ReadonlyArray<Row> };
      },
    };

    const lock = await acquirePlatformDatabaseLifecycleLockConnection(
      connection,
      manifest.id,
      manifest.ownershipNonce,
    );
    expect(lock.authoritativeManifest).toEqual(manifest);
    const next = transitionInstallation(manifest, 'provisioning', '2026-09-14T00:00:02.000Z');
    await lock.checkpoint!(next);
    expect(lock.authoritativeManifest).toEqual(next);
    expect(
      queries.find(({ sql }) => sql.includes('UPDATE "__void_platform_installation"'))?.values,
    ).toEqual([JSON.stringify(next), manifest.id, manifest.ownershipNonce]);
    await lock();
  });

  it('reads project Zero Trust state on the held lifecycle connection', async () => {
    const queries: Array<{ sql: string; values?: ReadonlyArray<unknown> }> = [];
    const connection = {
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: ReadonlyArray<unknown>,
      ) => {
        queries.push({ sql, values });
        if (sql.includes('FROM "__void_platform_installation"')) {
          return {
            rows: [
              { installation_id: 'install-one', ownership_nonce: 'nonce-one' },
            ] as unknown as ReadonlyArray<Row>,
          };
        }
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] as unknown as ReadonlyArray<Row> };
        }
        if (sql.includes('public.platform_settings')) {
          return {
            rows: [
              { settings: true, projects: true, present: true },
            ] as unknown as ReadonlyArray<Row>,
          };
        }
        if (sql.includes('FROM "platform_settings"')) {
          return {
            rows: [
              { value: { enabled: false, operation: { kind: 'disable' } } },
            ] as unknown as ReadonlyArray<Row>,
          };
        }
        return { rows: [] as ReadonlyArray<Row> };
      },
    };
    const lock = await acquirePlatformDatabaseLifecycleLockConnection(
      connection,
      'install-one',
      'nonce-one',
    );
    await expect(lock.readProjectZeroTrust!()).resolves.toEqual({
      active: true,
      applications: [],
      destinations: [],
      unfinishedDeletions: [],
      usersExist: false,
    });
    expect(queries.find(({ sql }) => sql.includes('FROM "platform_settings"'))?.values).toEqual([
      'zeroTrust.configuration',
    ]);
    expect(queries.some(({ sql }) => sql.includes('FROM "project_zero_trust"'))).toBe(true);

    // The same key the API's Zero Trust writers lock, held on this session.
    const unlock = await lock.lockProjectZeroTrust!();
    await unlock();
    await unlock();
    expect(
      queries.filter(({ sql }) => sql.includes("hashtext('zero-trust:configuration')")),
    ).toEqual([
      { sql: "SELECT pg_advisory_lock(hashtext('zero-trust:configuration'))", values: undefined },
      { sql: "SELECT pg_advisory_unlock(hashtext('zero-trust:configuration'))", values: undefined },
    ]);

    // Uninstall records itself where the API lock holders read it, and removes it.
    await lock.fenceProjectZeroTrust!();
    await lock.liftProjectZeroTrustFence!();
    const fence = queries.find(({ sql }) => sql.startsWith('INSERT INTO "platform_settings"'));
    expect(fence?.values?.[0]).toBe('platform.uninstall');
    expect(
      queries.find(({ sql }) => sql.startsWith('DELETE FROM "platform_settings"'))?.values,
    ).toEqual(['platform.uninstall']);
    await lock();
  });

  it('resolves the initial administrator to an immutable GitHub account id', async () => {
    const requests: Array<string> = [];
    await expect(
      resolveBootstrapGitHubId('Octocat', async (input) => {
        requests.push(String(input));
        return Response.json({ id: 583231 });
      }),
    ).resolves.toBe('583231');
    expect(requests).toEqual(['https://api.github.com/users/Octocat']);
  });

  it('preserves deployed secrets and never rotates restored runtime keys', () => {
    const {
      jwtSecret: _jwtSecret,
      projectSecretKey: _projectSecretKey,
      ...fresh
    } = FRESH_SECRETS_INPUT;
    const input = { ...fresh, existingInstallation: true };
    expect(createPlatformInstallationSecrets(input)).toMatchObject({
      jwtSecret: '',
      projectSecretKey: '',
    });

    const projectSecretKey = Buffer.alloc(32, 7).toString('base64');
    expect(
      createPlatformInstallationSecrets({
        ...input,
        jwtSecret: 'existing-jwt-secret',
        projectSecretKey,
      }),
    ).toMatchObject({ jwtSecret: 'existing-jwt-secret', projectSecretKey });

    const recoveredProjectSecretKey = Buffer.alloc(32, 9).toString('base64');
    expect(
      createPlatformInstallationSecrets({
        ...input,
        checkpoint: {
          cloudflareApiToken: 'old-cf-token',
          jwtSecret: 'recovered-jwt-secret',
          projectSecretKey: recoveredProjectSecretKey,
        },
        jwtSecret: 'wrong-exported-jwt-secret',
        projectSecretKey: Buffer.alloc(32, 3).toString('base64'),
      }),
    ).toMatchObject({
      cloudflareApiToken: 'cf-token',
      jwtSecret: 'recovered-jwt-secret',
      projectSecretKey: recoveredProjectSecretKey,
    });

    const currentV1 = Buffer.alloc(32, 10).toString('base64');
    const currentV2 = Buffer.alloc(32, 11).toString('base64');
    const restoredKeyring = createPlatformInstallationSecrets({
      ...input,
      checkpoint: {
        projectSecretActiveKeyVersion: 'v1',
        projectSecretKey: recoveredProjectSecretKey,
        projectSecretKeysJson: JSON.stringify({ v1: recoveredProjectSecretKey }),
      },
      projectSecretActiveKeyVersion: 'v2',
      projectSecretKeysJson: JSON.stringify({ v2: currentV2, v1: currentV1 }),
    });
    expect(restoredKeyring).toMatchObject({
      projectSecretActiveKeyVersion: 'v2',
      projectSecretKey: currentV1,
      projectSecretKeysJson: JSON.stringify({ v1: currentV1, v2: currentV2 }),
    });
    expect(
      platformWorkerSecretPayload('api', restoredKeyring, 'account', 'zone', false),
    ).toMatchObject({
      PROJECT_SECRET_ACTIVE_KEY_VERSION: 'v2',
      PROJECT_SECRET_KEYS_JSON: JSON.stringify({ v1: currentV1, v2: currentV2 }),
    });
    expect(platformWorkerSecretPayload('api', restoredKeyring, 'account', 'zone', true)).toBeNull();
  });

  it('stores a restored complete project-secret keyring in encrypted recovery state', async () => {
    const directory = useRegistryDirectory();
    const plan = await examplePlan(null, {
      emailSenderDomain: 'mail.example.com',
      emailSharedZoneId: 'mail-zone',
    });
    const manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt: '2026-09-16T00:00:00.000Z',
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: 'ownership-nonce-0123456789abcdef',
      platformVersion: '1.0.0',
    });
    writeInstallationManifest(manifest);
    const v1 = Buffer.alloc(32, 12).toString('base64');
    const v2 = Buffer.alloc(32, 13).toString('base64');
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '583231',
      bootstrapGitHubLogin: 'octocat',
      cloudflareApiToken: 'cf-token',
      checkpoint: {
        emailSigningSecret: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
        projectSecretActiveKeyVersion: 'v1',
        projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
        projectSecretKeysJson: JSON.stringify({ v1: TEST_PLATFORM_PROJECT_SECRET_KEY }),
      },
      databaseUrl: 'postgres://user:password@db.example.com/void',
      emailEnabled: true,
      existingEmailEnabled: true,
      existingInstallation: true,
      githubClientId: 'github-id',
      githubClientSecret: 'github-secret',
      jwtSecret: TEST_PLATFORM_JWT_SECRET,
      projectSecretActiveKeyVersion: 'v2',
      projectSecretKeysJson: JSON.stringify({ v1, v2 }),
      r2AccessKeyId: 'r2-id',
      r2SecretAccessKey: 'r2-secret',
    });

    await expect(
      installPlatform(plan, secrets, manifest, {
        acquireDatabaseLifecycleLock: async () => {
          throw new Error('must stop before acquiring a lock');
        },
        claimDatabase: async () => {
          throw new Error('stop after the encrypted checkpoint');
        },
        client: {} as never,
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('stop after the encrypted checkpoint');

    expect(readInstallationRecoverySecrets(manifest)).toMatchObject({
      emailSigningSecret: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
      projectSecretActiveKeyVersion: 'v2',
      projectSecretKey: v1,
      projectSecretKeysJson: JSON.stringify({ v1, v2 }),
    });
    const envelope = readFileSync(join(directory, 'account', `${manifest.id}.secrets.enc`), 'utf8');
    expect(envelope).not.toContain(v1);
    expect(envelope).not.toContain(v2);
    expect(envelope).not.toContain(TEST_PLATFORM_EMAIL_SIGNING_SECRET);
  });

  it("does not replay another workstation's stale recovery secrets during an upgrade", () => {
    const stale = {
      cloudflareApiToken: 'revoked-old-token',
      githubClientId: 'old-oauth-id',
      githubClientSecret: 'old-oauth-secret',
      r2AccessKeyId: 'old-r2-id',
      r2SecretAccessKey: 'old-r2-secret',
      jwtSecret: 'old-jwt',
      projectSecretKey: Buffer.alloc(32, 9).toString('base64'),
    };
    const input = {
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: '',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      existingInstallation: true,
      updateExistingWorkers: true,
      githubClientId: '',
      githubClientSecret: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
      checkpoint: stale,
    };
    const rotatedOnOtherHost = createPlatformInstallationSecrets({
      ...input,
      cloudflareApiToken: 'new-runtime-token',
    });
    expect(platformWorkerSecretPayload('api', rotatedOnOtherHost, 'account', 'zone', true)).toEqual(
      { CF_API_TOKEN: 'new-runtime-token' },
    );
    expect(
      platformWorkerSecretPayload('proxy', rotatedOnOtherHost, 'account', 'zone', true),
    ).toEqual({ CF_API_TOKEN: 'new-runtime-token' });
    const routineUpgrade = createPlatformInstallationSecrets(input);
    expect(routineUpgrade.cloudflareApiToken).toBe(stale.cloudflareApiToken);
    expect(platformWorkerSecretPayload('api', routineUpgrade, 'account', 'zone', true)).toBeNull();
    expect(
      platformWorkerSecretPayload('proxy', routineUpgrade, 'account', 'zone', true),
    ).toBeNull();
    // Recovery still supplies the known credentials when a Worker is missing.
    expect(
      platformWorkerSecretPayload('api', routineUpgrade, 'account', 'zone', false),
    ).toMatchObject({
      CF_API_TOKEN: stale.cloudflareApiToken,
      JWT_SECRET: stale.jwtSecret,
      PROJECT_SECRET_KEYS_JSON: JSON.stringify({ v1: stale.projectSecretKey }),
    });
    // Resuming install may pass values already read from its checkpoint; these
    // are not a request to replace secrets on Workers that already exist.
    const resumed = createPlatformInstallationSecrets({
      ...input,
      ...stale,
      updateExistingWorkers: false,
    });
    expect(platformWorkerSecretPayload('api', resumed, 'account', 'zone', true)).toBeNull();
  });

  it('resumes encrypted per-Worker credential updates without replaying the baseline', () => {
    useRegistryDirectory();
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-16T00:00:00.000Z',
      deployment,
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    writeInstallationManifest(manifest);
    const baseline = {
      cloudflareApiToken: 'old-runtime-token',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      githubClientId: 'old-github-id',
      githubClientSecret: 'old-github-secret',
      jwtSecret: TEST_PLATFORM_JWT_SECRET,
      projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
      r2AccessKeyId: 'old-r2-id',
      r2SecretAccessKey: 'old-r2-secret',
    };
    writePendingInstallationSecrets(manifest, baseline);
    promoteInstallationSecrets(manifest);

    const updates = {
      CF_API_TOKEN: 'new-runtime-token',
      GITHUB_CLIENT_ID: 'new-github-id',
      GITHUB_CLIENT_SECRET: 'new-github-secret',
      R2_ACCESS_KEY_ID: 'new-r2-id',
      R2_SECRET_ACCESS_KEY: 'new-r2-secret',
    };
    writePendingInstallationSecrets(manifest, {
      ...baseline,
      cloudflareApiToken: updates.CF_API_TOKEN,
      githubClientId: updates.GITHUB_CLIENT_ID,
      githubClientSecret: updates.GITHUB_CLIENT_SECRET,
      r2AccessKeyId: updates.R2_ACCESS_KEY_ID,
      r2SecretAccessKey: updates.R2_SECRET_ACCESS_KEY,
      workerSecretUpdatesJson: JSON.stringify({
        baselineGeneration: 0,
        generation: null,
        id: 'rotation-intent-a',
        schema: 1,
        updates,
      }),
    });
    const checkpoint = readInstallationRecoverySecrets(manifest)!;
    expect(checkpoint.cloudflareApiToken).toBe('new-runtime-token');
    const resumed = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: '',
      checkpoint,
      databaseUrl: baseline.databaseUrl,
      existingInstallation: true,
      githubClientId: '',
      githubClientSecret: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
      updateExistingWorkers: true,
    });
    expect(resumed.workerSecretUpdates).toEqual({});
    expect(resumed.pendingWorkerSecretUpdateIntent).toMatchObject({
      baselineGeneration: 0,
      generation: null,
      id: 'rotation-intent-a',
      updates,
    });

    writePendingInstallationSecrets(manifest, {
      ...checkpoint,
      workerSecretUpdatesJson: '',
    });
    promoteInstallationSecrets(manifest);
    const later = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: '',
      checkpoint: readInstallationRecoverySecrets(manifest),
      databaseUrl: baseline.databaseUrl,
      existingInstallation: true,
      githubClientId: '',
      githubClientSecret: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
      updateExistingWorkers: true,
    });
    expect(platformWorkerSecretPayload('api', later, 'account', 'zone', true)).toBeNull();
    expect(platformWorkerSecretPayload('proxy', later, 'account', 'zone', true)).toBeNull();

    writePendingInstallationSecrets(manifest, {
      ...baseline,
      cloudflareApiToken: updates.CF_API_TOKEN,
      workerSecretUpdatesJson: JSON.stringify({
        baselineGeneration: 0,
        generation: 1,
        id: 'rotation-intent-a',
        schema: 1,
        updates,
      }),
    });
    const completedElsewhere = {
      ...manifest,
      steps: [
        ...manifest.steps,
        {
          completedAt: '2026-09-16T00:01:00.000Z',
          key: 'worker-secret-updates:1:pending',
          resultHash: 'rotation-intent-a',
        },
        {
          completedAt: '2026-09-16T00:01:01.000Z',
          key: 'worker-cutover:1:committed',
          resultHash: 'committed',
        },
        {
          completedAt: '2026-09-16T00:01:02.000Z',
          key: 'worker-secret-updates:1:committed',
          resultHash: 'rotation-intent-a',
        },
      ],
    };
    expect(readInstallationRecoverySecrets(completedElsewhere)).toMatchObject({
      cloudflareApiToken: updates.CF_API_TOKEN,
    });
    expect(readInstallationRecoverySecrets(completedElsewhere)?.workerSecretUpdatesJson).toBe(
      undefined,
    );

    writePendingInstallationSecrets(manifest, {
      ...baseline,
      cloudflareApiToken: 'stale-runtime-token',
      workerSecretUpdatesJson: JSON.stringify({
        baselineGeneration: 0,
        generation: 1,
        id: 'rotation-intent-a',
        schema: 1,
        updates,
      }),
    });
    const supersededElsewhere = {
      ...completedElsewhere,
      steps: [
        ...completedElsewhere.steps,
        {
          completedAt: '2026-09-16T00:02:00.000Z',
          key: 'worker-secret-updates:2:pending',
          resultHash: 'rotation-intent-b',
        },
        {
          completedAt: '2026-09-16T00:02:01.000Z',
          key: 'worker-cutover:2:committed',
          resultHash: 'committed',
        },
        {
          completedAt: '2026-09-16T00:02:02.000Z',
          key: 'worker-secret-updates:2:committed',
          resultHash: 'rotation-intent-b',
        },
      ],
    };
    expect(readInstallationRecoverySecrets(supersededElsewhere)).toMatchObject({
      cloudflareApiToken: updates.CF_API_TOKEN,
    });
  });

  it('omits unavailable composite secrets so Cloudflare preserves deployed values', () => {
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: '',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      existingInstallation: true,
      githubClientId: '',
      githubClientSecret: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
    });

    expect(apiWorkerSecrets(secrets, 'account', 'zone')).toEqual({
      CF_ACCOUNT_ID: 'account',
      CF_ZONE_ID: 'zone',
    });
  });

  it('requires restored runtime secrets before recreating a missing platform Worker', async () => {
    const plan = await examplePlan();
    let manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt: '2026-01-01T00:00:00.000Z',
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: 'ownership-nonce-0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-01-01T00:00:00.000Z',
        key: 'bootstrap-access:v1',
        resultHash: 'bootstrap-hash',
      },
      '2026-01-01T00:00:00.000Z',
    );
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: '',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      existingInstallation: true,
      githubClientId: '',
      githubClientSecret: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
    });

    expect(() => assertRequiredPlatformSecrets(plan, manifest, secrets)).toThrow(
      'Creating a missing platform Worker requires: VOID_PLATFORM_GITHUB_CLIENT_ID',
    );
  });

  it('accepts a completed legacy authentication migration without setup authority on later upgrades', async () => {
    const original = await examplePlan();
    const plan = {
      ...original,
      actions: [],
      deployment: {
        ...original.deployment,
        schemaVersion: 3 as const,
        authentication: { ...original.deployment.authentication, configurable: true as const },
      },
    };
    let manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt: '2026-01-01T00:00:00.000Z',
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: 'ownership-nonce-0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: '',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      existingInstallation: true,
      githubClientId: '',
      githubClientSecret: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
    });

    expect(() => assertRequiredPlatformSecrets(plan, manifest, secrets)).toThrow(
      'administrator setup code',
    );
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-01-01T00:00:00.000Z',
        key: 'bootstrap-access:v1',
        resultHash: 'bootstrap-hash',
      },
      '2026-01-01T00:00:00.000Z',
    );
    expect(() => assertRequiredPlatformSecrets(plan, manifest, secrets)).not.toThrow();
  });

  it('recreates only the email gateway with its email key and no JWT or Cloudflare token', async () => {
    const fullPlan = await examplePlan(null, {
      emailSenderDomain: 'mail.example.com',
      emailSharedZoneId: 'mail-zone',
    });
    const plan = {
      ...fullPlan,
      actions: fullPlan.actions.filter((action) => action.key === 'email-gateway-worker'),
    };
    let manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt: '2026-01-01T00:00:00.000Z',
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: 'ownership-nonce-0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-01-01T00:00:00.000Z',
        key: 'bootstrap-access:v1',
        resultHash: 'bootstrap-hash',
      },
      '2026-01-01T00:00:00.000Z',
    );
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: '',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      existingInstallation: true,
      githubClientId: '',
      githubClientSecret: '',
      emailEnabled: true,
      emailSigningSecret: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
      existingEmailEnabled: true,
      jwtSecret: TEST_PLATFORM_JWT_SECRET,
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
    });

    expect(() => assertRequiredPlatformSecrets(plan, manifest, secrets)).not.toThrow();
    expect(platformWorkerSecretPayload('emailGateway', secrets, 'account', 'zone', false)).toEqual({
      EMAIL_SIGNING_SECRET: TEST_PLATFORM_EMAIL_SIGNING_SECRET,
    });
    expect(
      platformWorkerSecretPayload(
        'emailGateway',
        { ...secrets, cloudflareApiToken: 'must-not-be-deployed' },
        'account',
        'zone',
        false,
      ),
    ).toEqual({ EMAIL_SIGNING_SECRET: TEST_PLATFORM_EMAIL_SIGNING_SECRET });
    expect(
      platformWorkerSecretPayload('emailGateway', secrets, 'account', 'zone', true),
    ).toBeNull();
  });

  it('does not checkpoint failure when another host owns the lifecycle lock', async () => {
    const directory = useRegistryDirectory();
    const plan = await examplePlan();
    await expect(
      installPlatform(plan, freshSecrets(), null, {
        acquireDatabaseLifecycleLock: async () => {
          throw new Error('another host owns the lock');
        },
        claimDatabase,
        client: unusedClient(),
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('another host owns the lock');
    expect(listInstallationManifests(directory)[0]).toMatchObject({
      resources: [],
      status: 'planned',
    });
  });

  it('validates a resume only after reading the authoritative database checkpoint', async () => {
    useRegistryDirectory();
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment,
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = transitionInstallation(manifest, 'planned', '2026-09-14T00:00:01.000Z');
    manifest = transitionInstallation(manifest, 'provisioning', '2026-09-14T00:00:02.000Z');
    const routingName = deployment.resources.routingKv;
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:03.000Z',
        key: 'provision-intent:routing-kv',
        resultHash: platformProvisionIntentHash(
          manifest,
          'routing-kv',
          'kv-namespace',
          routingName,
        ),
      },
      '2026-09-14T00:00:03.000Z',
    );
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'routing-kv-id',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: routingName,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:04.000Z',
    );
    manifest = transitionInstallation(manifest, 'failed', '2026-09-14T00:00:05.000Z');
    writeInstallationManifest(manifest);
    const planner = {
      ...planningClient(),
      listKvNamespaces: async (_accountId: string, title?: string) =>
        title === routingName ? [{ id: 'routing-kv-id', name: routingName }] : [],
    };
    const plan = await createPlatformInstallPlan(planner, EXAMPLE_PLAN_INPUT, manifest);
    let released = false;
    const lock = Object.assign(
      async () => {
        released = true;
      },
      { authoritativeManifest: manifest },
    );

    await expect(
      installPlatform(plan, freshSecrets(), manifest, {
        acquireDatabaseLifecycleLock: async () => lock,
        claimDatabase,
        client: unusedClient(),
        revalidateBeforeWorkerDeploy: async () => {},
        verifyExistingOwnership: async (candidate, databaseCheckpointExists) => {
          expect(candidate).toEqual(manifest);
          expect(databaseCheckpointExists).toBe(true);
          throw new Error('ownership-checked');
        },
      }),
    ).rejects.toThrow('ownership-checked');
    expect(released).toBe(true);
  });

  async function appAccessInstall({
    legacyRuntime = false,
    appAccess,
    failAppAccess = false,
    failHealthToken = false,
  }: {
    legacyRuntime?: boolean;
    appAccess?: 'public' | 'custom';
    failAppAccess?: boolean;
    failHealthToken?: boolean;
  }) {
    const directory = useRegistryDirectory();
    const plan = await createPlatformInstallPlan(
      planningClient(),
      { ...EXAMPLE_PLAN_INPUT, appAccess },
      null,
      { includeEmailGateway: !legacyRuntime },
    );
    const packagedRuntime = resolvePlatformRuntime(getPlatformRuntimeDirectory());
    const { emailGateway: _legacyGateway, ...legacyArtifacts } = packagedRuntime.manifest.artifacts;
    const { emailProtocolVersion: _legacyProtocol, ...legacyManifest } = packagedRuntime.manifest;
    const selectedRuntime = legacyRuntime
      ? {
          ...packagedRuntime,
          manifest: { ...legacyManifest, artifacts: legacyArtifacts },
        }
      : packagedRuntime;
    let resourceIndex = 0;
    const created = async (_account: string, name: string) => ({
      id: `resource-${resourceIndex++}`,
      name,
    });
    const captured = {
      apiSecrets: null as Record<string, string> | null,
      r2OwnershipMarker: '',
      remoteManifest: '',
    };
    const deployed: Array<string> = [];
    const deployedTrafficStates: Array<unknown> = [];
    const routingValues = new Map<string, string>();
    const lifecycleEvents: Array<string> = [];
    const databaseClaims: Array<[string, string]> = [];
    const install = () =>
      installPlatform(plan, freshSecrets(), null, {
        runtime: selectedRuntime,
        prepareHealthAccess: async () => {
          if (failHealthToken) {
            throw new PlatformCloudflareApiError('rejected', 403);
          }
        },
        prepareAppAccess: async () =>
          JSON.stringify({
            version: 1,
            accountId: 'account',
            mode: appAccess === 'public' ? 'public' : 'protected',
            managed: true,
            apiToken: 'app-management-only',
            identityProviderIds: appAccess === 'public' ? [] : ['idp'],
            policyIds: appAccess === 'public' ? [] : ['policy'],
          }),
        initializeAppAccess: async ({ setupJson, setupToken }) => {
          expect(routingValues.get(PLATFORM_DISABLED_KEY)).toBe(PLATFORM_DISABLED_VALUE);
          expect(JSON.parse(setupJson).apiToken).toBe('app-management-only');
          expect(setupToken).toMatch(/^[a-f0-9]{64}$/);
          expect(captured.apiSecrets?.PLATFORM_APP_ACCESS_SETUP_TOKEN).toBe(setupToken);
          lifecycleEvents.push('app-access');
          if (failAppAccess) {
            throw new Error('app access not ready');
          }
        },
        acquireDatabaseLifecycleLock,
        claimDatabase: async (_url, installationId, ownershipNonce) => {
          databaseClaims.push([installationId, ownershipNonce]);
        },
        client: {
          createAiGateway: created,
          createDnsRecord: async (_zone, name) => ({
            content: '100::',
            id: `resource-${resourceIndex++}`,
            name,
            proxied: true,
            type: 'AAAA',
          }),
          createZone: async () => {
            throw new Error('existing zone must not be created');
          },
          createKvNamespace: created,
          createR2Bucket: created,
          createQueue: created,
          createDispatchNamespace: created,
          createHyperdrive: async (account, name) => created(account, name),
          deleteKvValue: async (_account, _namespace, key) => {
            lifecycleEvents.push(`delete:${key}`);
            routingValues.delete(key);
          },
          putKvValue: async (_account, _namespace, key, value) => {
            routingValues.set(key, value);
            if (key === PLATFORM_DISABLED_KEY) {
              lifecycleEvents.push(`put:${key}`);
            }
            if (key === '__void/platform/installation/v1') {
              captured.remoteManifest = value;
            }
          },
          putR2Object: async (_account, _bucket, _key, value) => {
            captured.r2OwnershipMarker = value;
          },
        },
        deployWorker: async (config, secrets) => {
          expect(routingValues.get(PLATFORM_DISABLED_KEY)).toBe(PLATFORM_DISABLED_VALUE);
          expect(routingValues.has(PLATFORM_SANDBOX_DRAIN_KEY)).toBe(false);
          lifecycleEvents.push(`deploy:${String(config.name)}`);
          deployed.push(String(config.name));
          deployedTrafficStates.push(
            (config.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE,
          );
          if (String(config.name).endsWith('-api')) {
            captured.apiSecrets = secrets;
          }
        },
        prepareDatabase,
        prepareSandboxDrain: async () => sandboxDrainPreparation('complete'),
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          expect(routingValues.get(PLATFORM_DISABLED_KEY)).toBe(
            lifecycleEvents.includes('verify') ? undefined : PLATFORM_DISABLED_VALUE,
          );
          lifecycleEvents.push('verify');
        },
        verifySandboxDrain: async () => {
          throw new Error('an empty fresh installation must not require a manual drain');
        },
      });
    return {
      captured,
      databaseClaims,
      deployed,
      deployedTrafficStates,
      directory,
      install,
      lifecycleEvents,
      plan,
      routingValues,
    };
  }

  it.each([
    { legacyRuntime: false },
    { legacyRuntime: true },
    { legacyRuntime: false, appAccess: 'public' as const },
    { legacyRuntime: false, appAccess: 'custom' as const },
  ])(
    'checkpoints app access and resource readiness before traffic opens: %j',
    async ({ legacyRuntime, appAccess }) => {
      const {
        captured,
        databaseClaims,
        deployed,
        deployedTrafficStates,
        directory,
        install,
        lifecycleEvents,
        plan,
        routingValues,
      } = await appAccessInstall({ legacyRuntime, appAccess });
      if (legacyRuntime) {
        expect(plan.actions.some((action) => action.key === 'email-gateway-worker')).toBe(false);
      }
      const result = await install();
      if (appAccess) {
        expect(lifecycleEvents.indexOf('app-access')).toBeLessThan(
          lifecycleEvents.indexOf(`delete:${PLATFORM_DISABLED_KEY}`),
        );
        expect(result.manifest.steps.some((step) => step.key === 'app-access-initialized:v1')).toBe(
          true,
        );
        expect(JSON.stringify(captured.apiSecrets)).not.toContain('app-management-only');
        expect(readInstallationRecoverySecrets(result.manifest)?.appAccessSetupJson).toContain(
          'app-management-only',
        );
      }
      expect(result.manifest.status).toBe('installed');
      expect(result.manifest.steps.some((step) => step.key === 'adoption-intent:zone')).toBe(true);
      expect(databaseClaims).toEqual([[result.manifest.id, result.manifest.ownershipNonce]]);
      expect(result.manifest.resources).toHaveLength(legacyRuntime ? 15 : 16);
      const workerOrder = [
        result.manifest.deployment.resources.apiWorker,
        result.manifest.deployment.resources.proxyWorker,
        ...(!legacyRuntime ? [result.manifest.deployment.resources.emailGatewayWorker] : []),
        result.manifest.deployment.resources.tailWorker,
        result.manifest.deployment.resources.dispatchWorker,
      ];
      expect(deployed).toEqual([...workerOrder, ...workerOrder]);
      const trafficStates = legacyRuntime
        ? ['staging', 'staging', undefined, 'staging', 'enabled', 'enabled', undefined, 'enabled']
        : [
            'staging',
            'staging',
            'staging',
            undefined,
            'staging',
            'enabled',
            'enabled',
            'enabled',
            undefined,
            'enabled',
          ];
      expect(deployedTrafficStates).toEqual(trafficStates);
      expect(captured.apiSecrets).toMatchObject({ PLATFORM_BOOTSTRAP_GITHUB_ID: '583231' });
      expect(JSON.parse(captured.r2OwnershipMarker)).toMatchObject({
        accountId: 'account',
        installationId: result.manifest.id,
        ownershipNonce: result.manifest.ownershipNonce,
        resourceKey: 'assets-bucket',
      });
      expect(JSON.parse(captured.remoteManifest)).toMatchObject({
        id: result.manifest.id,
        status: 'installed',
      });
      expect(routingValues.get('signup:enabled')).toBe('true');
      expect(JSON.parse(routingValues.get('signup:allowlist')!)).toEqual([]);
      expect(routingValues.has(PLATFORM_DISABLED_KEY)).toBe(false);
      expect(lifecycleEvents[0]).toBe(`put:${PLATFORM_DISABLED_KEY}`);
      expect(lifecycleEvents.filter((event) => event === 'verify')).toHaveLength(2);
      expect(lifecycleEvents.indexOf('verify')).toBeLessThan(
        lifecycleEvents.lastIndexOf(
          `deploy:${result.manifest.deployment.resources.dispatchWorker}`,
        ),
      );
      expect(lifecycleEvents.indexOf(`delete:${PLATFORM_DISABLED_KEY}`)).toBeLessThan(
        lifecycleEvents.lastIndexOf('verify'),
      );
      expect(listInstallationManifests(directory)).toHaveLength(1);
      expect(
        readdirSync(join(directory, 'account')).some((name) => name.endsWith('.secrets')),
      ).toBe(false);
    },
  );

  it('keeps traffic disabled when app access initialization fails', async () => {
    const { directory, install, lifecycleEvents, routingValues } = await appAccessInstall({
      appAccess: 'custom',
      failAppAccess: true,
    });
    await expect(install()).rejects.toThrow('app access not ready');
    expect(routingValues.get(PLATFORM_DISABLED_KEY)).toBe(PLATFORM_DISABLED_VALUE);
    expect(lifecycleEvents).not.toContain(`delete:${PLATFORM_DISABLED_KEY}`);
    expect(
      listInstallationManifests(directory)[0]?.steps.some(
        (step) => step.key === 'app-access-initialized:v1',
      ),
    ).toBe(false);
  });

  it('records a rejected app access token before deploying any Worker', async () => {
    const { deployed, directory, install } = await appAccessInstall({
      appAccess: 'custom',
      failHealthToken: true,
    });
    await expect(install()).rejects.toThrow('App access token rejected');
    expect(deployed).toEqual([]);
    const failed = listInstallationManifests(directory)[0]!;
    expect(readPendingInstallationSecrets(failed)?.appAccessTokenRejected).toBe('true');
  });

  it('closes the routing gate before an ambiguous fresh Worker upload', async () => {
    const directory = useRegistryDirectory();
    const plan = await examplePlan();
    let disabled = false;

    await expect(
      installPlatform(plan, freshSecrets(), null, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: {
          ...creatingClient(),
          putKvValue: async (_account, _namespace, key, value) => {
            if (key === PLATFORM_DISABLED_KEY) {
              expect(value).toBe(PLATFORM_DISABLED_VALUE);
              disabled = true;
            }
          },
        },
        deployWorker: async () => {
          expect(disabled).toBe(true);
          throw new Error('Worker upload response was lost');
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('Worker upload response was lost');

    expect(disabled).toBe(true);
    expect(listInstallationManifests(directory)[0]).toMatchObject({ status: 'failed' });
  });

  it('rejects a database URL Hyperdrive cannot use before claiming the database', async () => {
    const directory = useRegistryDirectory();
    const plan = await examplePlan();
    expect(plan.actions.find((action) => action.key === 'hyperdrive')?.action).toBe('create');
    let claims = 0;
    let locks = 0;

    await expect(
      installPlatform(
        plan,
        freshSecrets({
          databaseUrl: 'postgres://user:password@db.example.com/void?sslmode=disable',
        }),
        null,
        {
          acquireDatabaseLifecycleLock: async () => {
            locks++;
            return acquireDatabaseLifecycleLock();
          },
          claimDatabase: async () => {
            claims++;
          },
          client: unusedClient(),
          revalidateBeforeWorkerDeploy: async () => {},
        },
      ),
    ).rejects.toThrow('Unsupported sslmode');

    expect(claims).toBe(0);
    expect(locks).toBe(0);
    const manifest = listInstallationManifests(directory)[0]!;
    expect(manifest).toMatchObject({ resources: [], status: 'planned' });
    const checkpoint = readPendingInstallationSecrets(manifest);
    expect(checkpoint?.databaseClaimState).toBeUndefined();
    // The database is still unbound, so the operator can resume with a corrected URL.
    const corrected = 'postgres://user:password@db.example.com/void?sslmode=require';
    process.env.VOID_PLATFORM_DATABASE_URL = corrected;
    try {
      expect(resolvePlatformInstallDatabaseUrl(checkpoint, manifest)).toBe(corrected);
    } finally {
      delete process.env.VOID_PLATFORM_DATABASE_URL;
    }
  });

  it.each([
    'postgres://user:password@db.example.com/void?sslmode=verify-full&sslrootcert=/etc/ssl/private-ca.pem',
    'postgres://user:password@db.example.com/void?sslmode=verify-full&sslrootcert=system&sslrootcert=/etc/ssl/private-ca.pem',
  ])(
    'rejects a private certificate authority for a Void-created Hyperdrive before claiming the database: %s',
    async (databaseUrl) => {
      const directory = useRegistryDirectory();
      const plan = await examplePlan();
      expect(plan.actions.find((action) => action.key === 'hyperdrive')?.action).toBe('create');
      const secrets = (url: string) => freshSecrets({ databaseUrl: url });
      const hyperdriveRequests: Array<Record<string, unknown>> = [];
      const cloudflare = new PlatformCloudflareClient('cf-token', {
        fetcher: async (_input, init) => {
          hyperdriveRequests.push(JSON.parse(String(init?.body)));
          return Response.json({
            success: true,
            result: { id: 'hyperdrive-id', name: plan.deployment.resources.hyperdrive },
          });
        },
      });
      const claimedUrls: Array<string> = [];
      const lockedUrls: Array<string> = [];
      const dependencies: TestInstallerDependencies = {
        acquireDatabaseLifecycleLock: async (url) => {
          lockedUrls.push(url);
          return acquireDatabaseLifecycleLock();
        },
        claimDatabase: async (url) => {
          claimedUrls.push(url);
        },
        client: {
          ...creatingClient(),
          createHyperdrive: (account, name, connectionString) =>
            cloudflare.createHyperdrive(account, name, connectionString),
        },
        deployWorker: async () => {
          throw new Error('stop after resources');
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
      };

      const rejected = installPlatform(plan, secrets(databaseUrl), null, dependencies);
      await expect(rejected).rejects.toThrow(
        'A Hyperdrive created by Void trusts only public certificate authorities',
      );
      await expect(rejected).rejects.toThrow('Use an existing Hyperdrive');
      await expect(rejected).rejects.toThrow('VOID_PLATFORM_HYPERDRIVE_ID');

      expect(claimedUrls).toEqual([]);
      expect(lockedUrls).toEqual([]);
      expect(hyperdriveRequests).toEqual([]);
      const manifest = listInstallationManifests(directory)[0]!;
      expect(manifest).toMatchObject({ resources: [], status: 'planned' });
      const checkpoint = readPendingInstallationSecrets(manifest);
      expect(checkpoint?.databaseClaimState).toBeUndefined();

      // The database is still unbound, so the same installation resumes with a corrected URL.
      const corrected =
        'postgres://user:password@db.example.com/void?sslmode=verify-full&sslrootcert=system';
      process.env.VOID_PLATFORM_DATABASE_URL = corrected;
      let resumedUrl: string;
      try {
        resumedUrl = resolvePlatformInstallDatabaseUrl(checkpoint, manifest);
      } finally {
        delete process.env.VOID_PLATFORM_DATABASE_URL;
      }
      expect(resumedUrl).toBe(corrected);
      const resumedPlan = await examplePlan(manifest);
      expect(resumedPlan.actions.find((action) => action.key === 'hyperdrive')?.action).toBe(
        'create',
      );
      await expect(
        installPlatform(resumedPlan, secrets(resumedUrl), manifest, dependencies),
      ).rejects.toThrow('stop after resources');

      expect(claimedUrls).toEqual([corrected]);
      expect(lockedUrls).toEqual([corrected]);
      expect(hyperdriveRequests).toHaveLength(1);
      expect(hyperdriveRequests[0]).toMatchObject({ mtls: { sslmode: 'require' } });
    },
  );

  it('accepts a private certificate authority for an externally managed Hyperdrive', async () => {
    useRegistryDirectory();
    const databaseUrl =
      'postgres://user:password@db.example.com/void?sslmode=verify-full&sslrootcert=/etc/ssl/private-ca.pem';
    const plan = await createPlatformInstallPlan(
      {
        ...planningClient(),
        listHyperdriveConfigs: async () => [{ id: 'external-hyperdrive', name: 'managed-db' }],
      },
      {
        ...EXAMPLE_PLAN_INPUT,
        externalHyperdrive: {
          id: 'external-hyperdrive',
          name: 'managed-db',
          host: 'db.example.com',
          user: 'user',
        },
      },
      null,
    );
    expect(plan.actions.find((action) => action.key === 'hyperdrive')?.action).toBe('adopt');
    const claimedUrls: Array<string> = [];

    await expect(
      installPlatform(plan, freshSecrets({ databaseUrl }), null, {
        acquireDatabaseLifecycleLock,
        claimDatabase: async (url) => {
          claimedUrls.push(url);
          throw new Error('stop after claim');
        },
        client: {
          ...unusedClient(),
          createHyperdrive: async () => {
            throw new Error('an externally managed Hyperdrive must not be created');
          },
        },
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('stop after claim');

    expect(claimedUrls).toEqual([databaseUrl]);
    const manifest = listInstallationManifests()[0]!;
    const checkpoint = readPendingInstallationSecrets(manifest)!;
    expect(checkpoint.databaseClaimState).toBe('failed');
    expect(JSON.parse(checkpoint.externalHyperdriveJson!)).toEqual(plan.externalHyperdrive);
  });

  it('resumes a claimed verify-full database URL by creating Hyperdrive with its TLS mode', async () => {
    const directory = useRegistryDirectory();
    const databaseUrl = 'postgresql://user:password@db.example.com:5432/void?sslmode=verify-full';
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment,
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = transitionInstallation(manifest, 'planned', '2026-09-14T00:00:01.000Z');
    manifest = transitionInstallation(manifest, 'provisioning', '2026-09-14T00:00:02.000Z');
    // The earlier attempt claimed the database and recorded its Hyperdrive intent,
    // but Cloudflare rejected the create, so no Hyperdrive resource exists.
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:03.000Z',
        key: 'provision-intent:hyperdrive',
        resultHash: platformProvisionIntentHash(
          manifest,
          'hyperdrive',
          'hyperdrive',
          deployment.resources.hyperdrive,
        ),
      },
      '2026-09-14T00:00:03.000Z',
    );
    manifest = transitionInstallation(manifest, 'failed', '2026-09-14T00:00:04.000Z');
    writeInstallationManifest(manifest);
    writePendingInstallationSecrets(manifest, { databaseClaimState: 'claimed', databaseUrl });
    const resumedUrl = resolvePlatformInstallDatabaseUrl(
      readPendingInstallationSecrets(manifest),
      manifest,
    );
    expect(resumedUrl).toBe(databaseUrl);
    const plan = await examplePlan(manifest);
    expect(plan.actions.find((action) => action.key === 'hyperdrive')?.action).toBe('create');
    const hyperdriveRequests: Array<Record<string, unknown>> = [];
    const cloudflare = new PlatformCloudflareClient('cf-token', {
      fetcher: async (_input, init) => {
        hyperdriveRequests.push(JSON.parse(String(init?.body)));
        return Response.json({
          success: true,
          result: { id: 'hyperdrive-id', name: deployment.resources.hyperdrive },
        });
      },
    });
    const claimedUrls: Array<string> = [];
    const lockedUrls: Array<string> = [];

    await expect(
      installPlatform(plan, freshSecrets({ databaseUrl: resumedUrl }), manifest, {
        acquireDatabaseLifecycleLock: async (url) => {
          lockedUrls.push(url);
          return acquireDatabaseLifecycleLock();
        },
        claimDatabase: async (url) => {
          claimedUrls.push(url);
        },
        client: {
          ...creatingClient(),
          createHyperdrive: (account, name, connectionString) =>
            cloudflare.createHyperdrive(account, name, connectionString),
        },
        deployWorker: async () => {
          throw new Error('stop after resources');
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('stop after resources');

    expect(claimedUrls).toEqual([databaseUrl]);
    expect(lockedUrls).toEqual([databaseUrl]);
    expect(hyperdriveRequests).toHaveLength(1);
    expect(hyperdriveRequests[0]).toMatchObject({ mtls: { sslmode: 'require' } });
    expect(hyperdriveRequests[0]!.mtls).not.toHaveProperty('ca_certificate_id');
    expect(listInstallationManifests(directory)[0]!.resources).toContainEqual(
      expect.objectContaining({
        configHash: hyperdriveOriginConfigHash(hyperdriveOriginFromConnectionString(databaseUrl)),
        id: 'hyperdrive-id',
        key: 'hyperdrive',
        state: 'ready',
      }),
    );
  });

  it('keeps a cutover unresolved when the current Worker rollback is incomplete', async () => {
    const directory = useRegistryDirectory();
    const plan = await examplePlan();
    let deployments = 0;
    let previousRollbackRan = false;

    await expect(
      installPlatform(plan, freshSecrets(), null, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: creatingClient(),
        deployWorker: async () => {
          deployments++;
          if (deployments === 1) {
            return async () => {
              previousRollbackRan = true;
            };
          }
          throw new PlatformWorkerRecoveryIncompleteError(
            'platform: Automatic recovery for proxy was incomplete.',
          );
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('cutover remains unresolved');

    const failed = listInstallationManifests(directory)[0]!;
    expect(previousRollbackRan).toBe(true);
    expect(
      failed.steps.some(
        (step) => step.key.startsWith('worker-cutover:') && step.resultHash === 'restored',
      ),
    ).toBe(false);
    expect(failed.status).toBe('failed');
  });

  it('retains an ambiguous resource before recording its replacement', async () => {
    const plan = await examplePlan();
    const fingerprint = '2026-09-14T00:00:00.000Z';
    let manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: plan.deployment,
      id: plan.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '0.10.14',
    });
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: r2BucketConfigHash(plan.deployment.resources.assetsBucket, fingerprint),
        id: plan.deployment.resources.assetsBucket,
        key: 'assets-bucket',
        kind: 'r2-bucket',
        name: plan.deployment.resources.assetsBucket,
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    const replacement = {
      action: 'create' as const,
      id: null,
      key: 'assets-bucket',
      kind: 'r2-bucket' as const,
      name: `${plan.deployment.resources.assetsBucket}-replacement`,
      reason: 'Replace ambiguous bucket.',
    };
    const retained = retainReplacedInstallationResource(
      manifest,
      replacement,
      '2026-09-14T00:00:02.000Z',
    );
    expect(retained.resources).not.toContainEqual(
      expect.objectContaining({ key: 'assets-bucket' }),
    );
    expect(retained.resources).toContainEqual(
      expect.objectContaining({
        id: plan.deployment.resources.assetsBucket,
        kind: 'r2-bucket',
        state: 'retained',
      }),
    );
  });

  it('stops after a newly-created zone until nameservers become active', async () => {
    useRegistryDirectory();
    const plan = await createPlatformInstallPlan(
      { ...planningClient(), findZone: async () => null },
      {
        accountId: 'account',
        applicationDomain: 'example.net',
        controlPlaneDomain: '',
        dedicatedZone: true,
        displayName: 'Example',
        installationSlug: 'example',
        zoneName: 'example.net',
      },
      null,
    );
    const result = await installPlatform(plan, freshSecrets(), null, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: {
        createAiGateway: async () => {
          throw new Error('must wait for DNS');
        },
        createZone: async () => ({
          id: 'new-zone',
          name: 'example.net',
          nameServers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'],
          status: 'pending',
        }),
        createDnsRecord: async () => {
          throw new Error('must wait for DNS');
        },
        createKvNamespace: async () => {
          return { id: 'routing-kv-id', name: plan.deployment.resources.routingKv };
        },
        createR2Bucket: async () => {
          throw new Error('must wait for DNS');
        },
        createQueue: async () => {
          throw new Error('must wait for DNS');
        },
        createDispatchNamespace: async () => {
          throw new Error('must wait for DNS');
        },
        createHyperdrive: async () => {
          throw new Error('must wait for DNS');
        },
        putKvValue: async () => {
          // The remote recovery checkpoint is established before waiting.
        },
        putR2Object: async () => {
          throw new Error('must wait for DNS');
        },
      },
      revalidateBeforeWorkerDeploy: async () => {},
    });
    expect(result.waitingForDns).toBe(true);
    expect(result.manifest.status).toBe('waiting-for-dns');
    expect(result.manifest.resources.map((resource) => resource.key).sort()).toEqual([
      'routing-kv',
      'zone',
    ]);
  });

  async function installedPlatform() {
    const directory = useRegistryDirectory();
    const secrets = freshSecrets();
    const client = creatingClient();
    const installed = await installPlatform(await examplePlan(), secrets, null, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: {
        ...client,
        createAiGateway: async (_account, name) => ({ id: name, name }),
        deleteKvValue: async () => {},
      },
      deployWorker: async () => {},
      bootstrapEmail: async () => {
        throw new Error('email bootstrap must stay disabled');
      },
      prepareDatabase,
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
    });
    const byKey = new Map(installed.manifest.resources.map((resource) => [resource.key, resource]));
    const named = (key: string) => {
      const resource = byKey.get(key)!;
      return { id: resource.id, name: resource.name };
    };
    const deployment = installed.manifest.deployment;
    const assetsBucket = byKey.get('assets-bucket')!;
    const upgradedPlan = await createPlatformInstallPlan(
      {
        ...planningClient(),
        getR2Object: async () =>
          JSON.stringify(
            createPlatformResourceOwnershipMarker({
              accountId: installed.manifest.account.id,
              installationId: installed.manifest.id,
              ownershipNonce: installed.manifest.ownershipNonce,
              resourceId: assetsBucket.id,
              resourceKey: assetsBucket.key,
              resourceKind: assetsBucket.kind,
              resourceName: assetsBucket.name,
            }),
          ),
        listAiGateways: async () => [named('ai-gateway')],
        listDnsRecords: async () => [
          {
            ...named('application-dns'),
            content: '100::',
            proxied: true,
            type: 'AAAA',
          },
        ],
        listKvNamespaces: async (_account: string, title?: string) => {
          const match = installed.manifest.resources.find(
            (resource) => resource.kind === 'kv-namespace' && resource.name === title,
          );
          return match ? [{ id: match.id, name: match.name }] : [];
        },
        listR2Buckets: async () => [
          { ...named('assets-bucket'), fingerprint: '2026-09-14T00:00:00.000Z' },
        ],
        listQueues: async (_account: string, name: string) => {
          const match = installed.manifest.resources.find(
            (resource) => resource.kind === 'queue' && resource.name === name,
          );
          return match ? [{ id: match.id, name: match.name }] : [];
        },
        listDispatchNamespaces: async () => [named('dispatch-namespace')],
        listHyperdriveConfigs: async () => [named('hyperdrive')],
        listWorkerNames: async () => [
          deployment.resources.apiWorker,
          deployment.resources.proxyWorker,
          deployment.resources.emailGatewayWorker,
          deployment.resources.tailWorker,
          deployment.resources.dispatchWorker,
        ],
      },
      EXAMPLE_PLAN_INPUT,
      installed.manifest,
    );
    const upgradeKvWrites: Array<string> = [];
    const deletedKvValues: Array<string> = [];
    const upgradeClient = {
      ...client,
      deleteKvValue: async (_account: string, _namespace: string, key: string) => {
        deletedKvValues.push(key);
      },
      putKvValue: async (_account: string, _namespace: string, key: string) => {
        upgradeKvWrites.push(key);
      },
    };
    return {
      byKey,
      deletedKvValues,
      deployment,
      directory,
      installed,
      secrets,
      sourceManifest: { ...installed.manifest, platformVersion: '0.10.13' },
      upgradeClient,
      upgradeKvWrites,
      upgradedPlan,
    };
  }

  async function upgradedPlatform() {
    const platform = await installedPlatform();
    const deployed: Array<string> = [];
    let migrations = 0;
    const upgraded = await installPlatform(
      platform.upgradedPlan,
      platform.secrets,
      platform.sourceManifest,
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: platform.upgradeClient,
        deployWorker: async (config, secretPayload) => {
          expect(secretPayload).toBeNull();
          deployed.push(String(config.name));
        },
        prepareDatabase: async () => {
          migrations++;
          return prepareDatabase();
        },
        revalidateBeforeWorkerDeploy: async () => {},
        runtime: resolvePlatformRuntime(getPlatformRuntimeDirectory()),
        verifyHealth: async () => {},
      },
    );
    return { ...platform, deployed, migrations, upgraded };
  }

  async function disabledPlatform() {
    const platform = await upgradedPlatform();
    const { directory, secrets, upgraded, upgradedPlan, upgradeClient } = platform;
    const disabledConfigs: Array<Record<string, unknown>> = [];
    let disabledHealthChecks = 0;
    const disabledUpgrade = await installPlatform(
      upgradedPlan,
      secrets,
      {
        ...setInstallationDesiredState(upgraded.manifest, 'disabled', '2026-09-14T00:00:04.000Z'),
        status: 'disabled',
      },
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          disabledConfigs.push(config);
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          disabledHealthChecks++;
        },
      },
    );
    let interrupted = false;
    await expect(
      installPlatform(upgradedPlan, secrets, disabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async () => {
          interrupted = true;
          throw new Error('interrupted deployment');
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('interrupted deployment');
    const failedDisabledUpgrade = listInstallationManifests(directory)[0]!;
    const resumedConfigs: Array<Record<string, unknown>> = [];
    const resumedDisabledUpgrade = await installPlatform(
      upgradedPlan,
      secrets,
      failedDisabledUpgrade,
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          resumedConfigs.push(config);
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
      },
    );
    return {
      ...platform,
      disabledConfigs,
      disabledHealthChecks,
      disabledUpgrade,
      failedDisabledUpgrade,
      interrupted,
      resumedConfigs,
      resumedDisabledUpgrade,
    };
  }

  async function enabledPlatform() {
    const platform = await disabledPlatform();
    const { deletedKvValues, resumedDisabledUpgrade, secrets, upgradedPlan, upgradeClient } =
      platform;
    deletedKvValues.splice(0);
    const enabledConfigs: Array<Record<string, unknown>> = [];
    let enabledHealthChecks = 0;
    const enabledUpgrade = await installPlatform(
      upgradedPlan,
      secrets,
      setInstallationDesiredState(
        resumedDisabledUpgrade.manifest,
        'enabled',
        '2026-09-14T00:00:05.000Z',
      ),
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          enabledConfigs.push(config);
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          enabledHealthChecks++;
        },
      },
    );
    return { ...platform, enabledConfigs, enabledHealthChecks, enabledUpgrade };
  }

  function cutoverSnapshot(
    workerName: string,
    previousVersionId: string | null,
    stagedVersionId: string,
  ) {
    return Buffer.from(
      JSON.stringify({
        previousTriggers: {
          crons: [],
          preview_urls: true,
          queueConsumers: [],
          routes: [],
          workers_dev: true,
          workflows: [],
        },
        previousVersionId,
        schema: 1,
        stagedVersionId,
        workerName,
      }),
    ).toString('base64url');
  }

  it('redeploys every Worker while reusing provisioned resources on upgrade', async () => {
    const {
      byKey,
      deployed,
      deployment,
      installed,
      migrations,
      secrets,
      upgraded,
      upgradeKvWrites,
    } = await upgradedPlatform();
    expect(installed.manifest.deployment.capabilities.email).toBe(false);
    expect(byKey.get('hyperdrive')?.configHash).toBe(
      hyperdriveOriginConfigHash(hyperdriveOriginFromConnectionString(secrets.databaseUrl)),
    );
    expect(deployed).toEqual([
      deployment.resources.apiWorker,
      deployment.resources.proxyWorker,
      deployment.resources.emailGatewayWorker,
      deployment.resources.tailWorker,
      deployment.resources.dispatchWorker,
      deployment.resources.apiWorker,
      deployment.resources.proxyWorker,
      deployment.resources.emailGatewayWorker,
      deployment.resources.tailWorker,
      deployment.resources.dispatchWorker,
    ]);
    expect(migrations).toBe(0);
    expect(new Set(upgradeKvWrites)).toEqual(
      new Set(['__void/platform/installation/v1', PLATFORM_DISABLED_KEY]),
    );
    expect(upgraded.manifest.status).toBe('installed');
    expect(upgraded.manifest.platformVersion).toBe(readPlatformRuntimeManifest().platformVersion);
    expect(upgraded.manifest.runtime).toMatchObject({
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      source: 'custom',
    });
    expect(upgraded.manifest.resources).toHaveLength(16);
  });

  describe('Workers changed outside Void', () => {
    async function upgradeWithOutsideChange(
      uploadOutsideChanges: NonNullable<TestInstallerDependencies['uploadOutsideChanges']>,
    ) {
      const { deployment, directory, secrets, sourceManifest, upgradeClient, upgradedPlan } =
        await installedPlatform();
      // An older installation has no ISR cache yet, so this run creates it.
      const source = {
        ...sourceManifest,
        resources: sourceManifest.resources.filter((resource) => resource.key !== 'isr-cache-kv'),
      };
      const plan = {
        ...upgradedPlan,
        actions: upgradedPlan.actions.map((action) =>
          action.key === 'isr-cache-kv'
            ? { ...action, action: 'create' as const, id: null, reason: 'new in this version' }
            : action,
        ),
      };
      const events: Array<string> = [];
      const created: Array<string> = [];
      const error = await installPlatform(plan, secrets, source, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: {
          ...upgradeClient,
          createKvNamespace: async (account, name) => {
            const namespace = await upgradeClient.createKvNamespace(account, name);
            created.push(namespace.id);
            events.push(`create:${name}`);
            return namespace;
          },
          putKvValue: async (_account, _namespace, key) => {
            events.push(`put:${key}`);
          },
        },
        deployWorker: async (config) => {
          events.push(`deploy:${String(config.name)}`);
        },
        onProgress: (message) => {
          events.push(`progress:${message}`);
        },
        prepareDatabase,
        replaceOutsideChanges: [deployment.resources.apiWorker],
        revalidateBeforeWorkerDeploy: async () => {},
        runtime: resolvePlatformRuntime(getPlatformRuntimeDirectory()),
        uploadOutsideChanges: async (configs) => {
          events.push('outside-change-upload');
          await uploadOutsideChanges(configs);
        },
        verifyHealth: async () => {},
      }).then(
        () => null,
        (failure: unknown) => failure as Error,
      );
      return { created, deployment, directory, error, events, source };
    }

    it('uploads them after the run creates resources and before traffic pauses', async () => {
      const uploaded: Array<Record<string, unknown>> = [];
      const { created, deployment, error, events, source } = await upgradeWithOutsideChange(
        async (configs) => {
          uploaded.push(...configs);
        },
      );

      expect(error).toBeNull();
      const at = (index: number) => {
        expect(index).toBeGreaterThan(-1);
        return index;
      };
      const upload = at(events.indexOf('outside-change-upload'));
      expect(at(events.indexOf(`create:${deployment.resources.isrCacheKv}`))).toBeLessThan(upload);
      expect(at(events.indexOf('progress:Checking platform safety'))).toBeLessThan(upload);
      expect(upload).toBeLessThan(at(events.indexOf(`put:${PLATFORM_DISABLED_KEY}`)));
      expect(upload).toBeLessThan(at(events.findIndex((event) => event.startsWith('deploy:'))));
      expect(events.filter((event) => event === 'outside-change-upload')).toHaveLength(1);
      // The upload uses the config that the run deploys, with the ISR cache it created.
      expect(uploaded.map((config) => config.name)).toEqual([deployment.resources.apiWorker]);
      expect(created).toHaveLength(1);
      expect(source.resources.map((resource) => resource.id)).not.toContain(created[0]);
      expect(uploaded[0]!.kv_namespaces).toContainEqual({ binding: 'ISR_CACHE', id: created[0] });
    });

    it('uploads them also when the run does not pause traffic', async () => {
      const { secrets, deployment, upgradedPlan, upgradeClient, upgraded } =
        await upgradedPlatform();
      const events: Array<string> = [];
      const uploaded: Array<Record<string, unknown>> = [];
      await installPlatform(upgradedPlan, secrets, upgraded.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: {
          ...upgradeClient,
          putKvValue: async (_account, _namespace, key) => {
            events.push(`put:${key}`);
          },
        },
        deployWorker: async (config) => {
          events.push(`deploy:${String(config.name)}`);
        },
        prepareDatabase,
        replaceOutsideChanges: [deployment.resources.apiWorker],
        revalidateBeforeWorkerDeploy: async () => {},
        runtime: resolvePlatformRuntime(getPlatformRuntimeDirectory()),
        uploadOutsideChanges: async (configs) => {
          events.push('outside-change-upload');
          uploaded.push(...configs);
        },
        verifyHealth: async () => {},
      });

      expect(events).not.toContain(`put:${PLATFORM_DISABLED_KEY}`);
      expect(events.indexOf('outside-change-upload')).toBeGreaterThan(-1);
      expect(events.indexOf('outside-change-upload')).toBeLessThan(
        events.findIndex((event) => event.startsWith('deploy:')),
      );
      expect(uploaded.map((config) => config.name)).toEqual([deployment.resources.apiWorker]);
    });

    it('leaves traffic and Workers alone when that upload fails', async () => {
      const refusal =
        'platform: The Cloudflare CLI did not replace the changes to the Worker. Its output above shows why. No deployment changed, and application traffic was not paused.';
      const { directory, error, events } = await upgradeWithOutsideChange(async () => {
        throw new Error(refusal);
      });

      expect(error?.message).toBe(refusal);
      expect(events).toContain('outside-change-upload');
      expect(events).not.toContain(`put:${PLATFORM_DISABLED_KEY}`);
      expect(events.filter((event) => event.startsWith('deploy:'))).toEqual([]);
      expect(listInstallationManifests(directory)[0]).toMatchObject({
        status: 'failed',
        operation: { phase: 'failed' },
      });
    });
  });

  it('resumes an interrupted Worker secret rotation and commits the next one', async () => {
    const {
      directory,
      secrets,
      installed,
      deployment,
      upgradedPlan,
      upgradeClient,
      sourceManifest,
    } = await installedPlatform();
    const interruptedProtocolEvents: Array<string> = [];
    const legacySourceManifest = {
      ...sourceManifest,
      usageProtocolVersion: 1 as const,
    };
    const rotatedWorkerSecrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: 'rotated-cf-token',
      checkpoint: readInstallationRecoverySecrets(installed.manifest),
      databaseUrl: secrets.databaseUrl,
      existingInstallation: true,
      githubClientId: 'rotated-github-id',
      githubClientSecret: 'rotated-github-secret',
      r2AccessKeyId: 'rotated-r2-id',
      r2SecretAccessKey: 'rotated-r2-secret',
      updateExistingWorkers: true,
    });
    await expect(
      installPlatform(upgradedPlan, rotatedWorkerSecrets, legacySourceManifest, {
        acquireDatabaseLifecycleLock: async () =>
          Object.assign(async () => {}, {
            prepareSandboxDrain: async () => sandboxDrainPreparation('complete'),
            readAuthenticationState: async () => ({
              enabledProviders: ['google', 'oidc'] as const,
              sessionsRequired: true,
              protectedByAccess: false,
              protection: null,
            }),
          }),
        claimDatabase,
        client: {
          ...upgradeClient,
          putKvValue: async (_account, _namespace, key) => {
            if (key === PLATFORM_DISABLED_KEY) {
              interruptedProtocolEvents.push('gate:closed');
            }
          },
        },
        deployWorker: async (config, secretPayload) => {
          const name = String(config.name);
          interruptedProtocolEvents.push(`deploy:${name}`);
          if (name === deployment.resources.apiWorker) {
            expect(secretPayload).toEqual({
              CF_API_TOKEN: 'rotated-cf-token',
              GITHUB_CLIENT_ID: 'rotated-github-id',
              GITHUB_CLIENT_SECRET: 'rotated-github-secret',
              R2_ACCESS_KEY_ID: 'rotated-r2-id',
              R2_SECRET_ACCESS_KEY: 'rotated-r2-secret',
            });
          }
          if (name === deployment.resources.proxyWorker) {
            expect(secretPayload).toEqual({ CF_API_TOKEN: 'rotated-cf-token' });
          }
          if (name === deployment.resources.proxyWorker) {
            throw new Error('interrupted after API activation');
          }
          return async () => {
            interruptedProtocolEvents.push(`rollback:${name}`);
          };
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          throw new Error('health must not run before every Worker is staged');
        },
      }),
    ).rejects.toThrow('interrupted after API activation');
    expect(interruptedProtocolEvents).toEqual([
      'gate:closed',
      `deploy:${deployment.resources.apiWorker}`,
      `deploy:${deployment.resources.proxyWorker}`,
      'gate:closed',
    ]);
    const interruptedManifest = listInstallationManifests(directory)[0]!;
    expect(interruptedManifest).toMatchObject({
      status: 'failed',
      usageProtocolVersion: 1,
    });
    const interruptedSecretCheckpoint = readInstallationRecoverySecrets(interruptedManifest)!;
    const resumedWorkerSecrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: 'retry-cf-token',
      checkpoint: interruptedSecretCheckpoint,
      databaseUrl: secrets.databaseUrl,
      existingInstallation: true,
      githubClientId: '',
      githubClientSecret: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
      updateExistingWorkers: true,
    });
    expect(resumedWorkerSecrets.workerSecretUpdates).toEqual({
      CF_API_TOKEN: 'retry-cf-token',
    });
    expect(resumedWorkerSecrets.pendingWorkerSecretUpdateIntent?.updates).toEqual(
      rotatedWorkerSecrets.workerSecretUpdates,
    );
    const resumedUpdates = {
      ...rotatedWorkerSecrets.workerSecretUpdates,
      CF_API_TOKEN: 'retry-cf-token',
    };

    const emptyCoreUpgradeConfigs: Array<Record<string, unknown>> = [];
    const resumedSecretPayloads: Array<Record<string, string> | null> = [];
    const emptyCoreUpgrade = await installPlatform(
      upgradedPlan,
      resumedWorkerSecrets,
      {
        ...sourceManifest,
        safetyProtocols: { sandboxDrain: 0 },
        steps: interruptedManifest.steps,
      },
      {
        acquireDatabaseLifecycleLock: async () =>
          Object.assign(async () => {}, {
            prepareSandboxDrain: async () => sandboxDrainPreparation('complete'),
            readAuthenticationState: async () => ({
              enabledProviders: ['google', 'oidc'] as const,
              sessionsRequired: true,
              protectedByAccess: false,
              protection: null,
            }),
          }),
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config, secretPayload) => {
          emptyCoreUpgradeConfigs.push(config);
          resumedSecretPayloads.push(secretPayload);
        },
        prepareDatabase,
        prepareSandboxDrain: async () => sandboxDrainPreparation('complete'),
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {},
        verifySandboxDrain: async () => {
          throw new Error('empty core upgrade must not require a manual drain');
        },
      },
    );
    expect(emptyCoreUpgrade.waitingForSandboxDrain).toBe(false);
    expect(emptyCoreUpgrade.manifest.safetyProtocols).toEqual({ sandboxDrain: 3 });
    expect(emptyCoreUpgrade.manifest.deployment).toMatchObject({
      schemaVersion: 3,
      authentication: { configurable: true, providers: ['google', 'oidc'] },
      capabilities: { githubOAuth: false, googleOAuth: true },
    });
    expect(emptyCoreUpgradeConfigs).toHaveLength(10);
    expect(resumedSecretPayloads.slice(0, 2)).toEqual([
      resumedUpdates,
      { CF_API_TOKEN: 'retry-cf-token' },
    ]);
    expect(
      readInstallationRecoverySecrets(emptyCoreUpgrade.manifest)?.workerSecretUpdatesJson,
    ).toBe(undefined);
    for (const index of [0, 1, 2, 4]) {
      expect(
        (emptyCoreUpgradeConfigs[index]!.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE,
      ).toBe('staging');
    }
    for (const index of [5, 6, 7, 9]) {
      expect(
        (emptyCoreUpgradeConfigs[index]!.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE,
      ).toBe('enabled');
    }
    const nextRotationSecrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      cloudflareApiToken: 'next-cf-token',
      checkpoint: readInstallationRecoverySecrets(emptyCoreUpgrade.manifest),
      databaseUrl: secrets.databaseUrl,
      existingInstallation: true,
      githubClientId: '',
      githubClientSecret: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
      updateExistingWorkers: true,
    });
    const nextRotationPayloads: Array<Record<string, string> | null> = [];
    const nextRotation = await installPlatform(
      upgradedPlan,
      nextRotationSecrets,
      emptyCoreUpgrade.manifest,
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (_config, secretPayload) => {
          nextRotationPayloads.push(secretPayload);
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {},
      },
    );
    expect(nextRotationPayloads.slice(0, 2)).toEqual([
      { CF_API_TOKEN: 'next-cf-token' },
      { CF_API_TOKEN: 'next-cf-token' },
    ]);
    expect(
      nextRotation.manifest.steps.filter((step) => step.key.startsWith('worker-secret-updates:')),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: expect.stringMatching(/:pending$/) }),
        expect.objectContaining({ key: expect.stringMatching(/:committed$/) }),
      ]),
    );
  });

  it('waits for the sandbox drain before enabling traffic and resumes the same operation', async () => {
    const { secrets, deployment, upgradedPlan, upgradeClient, sourceManifest } =
      await installedPlatform();
    const sandboxDrainDeployments: Array<string> = [];
    const sandboxDrainTrafficStates: Array<unknown> = [];
    const sandboxDrainEvents: Array<string> = [];
    const waitingForSandboxDrain = await installPlatform(
      upgradedPlan,
      secrets,
      { ...sourceManifest, safetyProtocols: { sandboxDrain: 0 } },
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: {
          ...upgradeClient,
          deleteKvValue: async () => {
            sandboxDrainEvents.push('gate:open');
          },
          putKvValue: async (_account, _namespace, key) => {
            if (key === PLATFORM_DISABLED_KEY) {
              sandboxDrainEvents.push('gate:closed');
            }
          },
        },
        deployWorker: async (config) => {
          sandboxDrainDeployments.push(String(config.name));
          sandboxDrainTrafficStates.push(
            (config.vars as Record<string, unknown> | undefined)?.PLATFORM_TRAFFIC_STATE,
          );
        },
        prepareDatabase,
        prepareSandboxDrain: async () => sandboxDrainPreparation('pending'),
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          sandboxDrainEvents.push('health');
        },
        verifySandboxDrain: async () => {
          sandboxDrainEvents.push('drain:required');
          return false;
        },
      },
    );
    expect(waitingForSandboxDrain.waitingForSandboxDrain).toBe(true);
    expect(waitingForSandboxDrain.manifest).toMatchObject({
      operation: { action: 'upgrade', phase: 'waiting-for-sandbox-drain' },
      platformVersion: '0.10.13',
      safetyProtocols: { sandboxDrain: 3 },
      status: 'verifying',
    });
    expect(sandboxDrainDeployments).toEqual([
      deployment.resources.apiWorker,
      deployment.resources.proxyWorker,
      deployment.resources.emailGatewayWorker,
      deployment.resources.tailWorker,
      deployment.resources.dispatchWorker,
    ]);
    expect(sandboxDrainTrafficStates).toEqual([
      'sandbox-drain',
      'sandbox-drain',
      'sandbox-drain',
      undefined,
      'sandbox-drain',
    ]);
    expect(sandboxDrainEvents).toEqual(['gate:closed', 'health', 'drain:required']);

    const resumedDrainDeployments: Array<string> = [];
    const resumedDrainEvents: Array<string> = [];
    let resumedDrainPreparations = 0;
    const resumedAfterSandboxDrain = await installPlatform(
      upgradedPlan,
      secrets,
      waitingForSandboxDrain.manifest,
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: {
          ...upgradeClient,
          deleteKvValue: async (_account, _namespace, key) => {
            if (key === PLATFORM_DISABLED_KEY) {
              resumedDrainEvents.push('gate:open');
            }
          },
          putKvValue: async (_account, _namespace, key) => {
            if (key === PLATFORM_DISABLED_KEY) {
              resumedDrainEvents.push('gate:closed');
            }
          },
        },
        deployWorker: async (config) => {
          resumedDrainDeployments.push(
            `${String(config.name)}:${String(
              (config.vars as Record<string, unknown> | undefined)?.PLATFORM_TRAFFIC_STATE,
            )}`,
          );
        },
        prepareDatabase,
        prepareSandboxDrain: async () =>
          sandboxDrainPreparation(resumedDrainPreparations++ === 0 ? 'pending' : 'complete'),
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          resumedDrainEvents.push('health');
        },
        verifySandboxDrain: async () => {
          resumedDrainEvents.push('drain:complete');
          return true;
        },
      },
    );
    expect(resumedAfterSandboxDrain.manifest.operation).toMatchObject({
      id: waitingForSandboxDrain.manifest.operation!.id,
      startedAt: waitingForSandboxDrain.manifest.operation!.startedAt,
      phase: 'complete',
    });
    expect(resumedAfterSandboxDrain.waitingForSandboxDrain).toBe(false);
    expect(resumedAfterSandboxDrain.manifest).toMatchObject({
      safetyProtocols: { sandboxDrain: 3 },
      status: 'installed',
    });
    expect(resumedDrainDeployments).toHaveLength(10);
    expect(resumedDrainDeployments.slice(0, 5)).toEqual([
      `${deployment.resources.apiWorker}:sandbox-drain`,
      `${deployment.resources.proxyWorker}:sandbox-drain`,
      `${deployment.resources.emailGatewayWorker}:sandbox-drain`,
      `${deployment.resources.tailWorker}:undefined`,
      `${deployment.resources.dispatchWorker}:sandbox-drain`,
    ]);
    expect(resumedDrainDeployments.slice(5)).toEqual([
      `${deployment.resources.apiWorker}:enabled`,
      `${deployment.resources.proxyWorker}:enabled`,
      `${deployment.resources.emailGatewayWorker}:enabled`,
      `${deployment.resources.tailWorker}:undefined`,
      `${deployment.resources.dispatchWorker}:enabled`,
    ]);
    expect(resumedDrainEvents).toEqual([
      'gate:closed',
      'health',
      'drain:complete',
      'gate:open',
      'health',
    ]);
  });

  it('keeps the source version when upgrade health fails', async () => {
    const { directory, secrets, upgradedPlan, upgradeClient, sourceManifest } =
      await installedPlatform();
    let verifiedTargetVersion = '';
    await expect(
      installPlatform(upgradedPlan, secrets, sourceManifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async () => async () => {},
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async (_api, _id, _proxy, _domain, platformVersion) => {
          verifiedTargetVersion = platformVersion;
          throw new Error('upgrade health failed');
        },
      }),
    ).rejects.toThrow('upgrade health failed');
    expect(verifiedTargetVersion).toBe(readPlatformRuntimeManifest().platformVersion);
    expect(listInstallationManifests(directory)[0]?.platformVersion).toBe('0.10.13');
    expect(listInstallationManifests(directory)[0]?.operation).toMatchObject({
      action: 'upgrade',
      phase: 'failed',
    });
  });

  it('rolls the database schema back and forward from recorded manifests', async () => {
    const { secrets, upgradedPlan, upgradeClient, upgraded } = await upgradedPlatform();
    const currentRuntime = resolvePlatformRuntime(getPlatformRuntimeDirectory());
    const earlierDatabase = migrationSubset(currentRuntime.manifest.database.migrations.length - 1);
    const earlierRuntime = {
      ...currentRuntime,
      manifest: {
        ...currentRuntime.manifest,
        database: earlierDatabase,
        platformVersion: '0.10.13-compatible',
      },
      manifestSha256: 'a'.repeat(64),
    };
    const rollbackSource = {
      ...currentRuntime,
      manifest: {
        ...currentRuntime.manifest,
        database: {
          ...currentRuntime.manifest.database,
          rollbackSafeFrom: [
            ...currentRuntime.manifest.database.rollbackSafeFrom,
            {
              platformVersion: earlierRuntime.manifest.platformVersion,
              schemaDigest: earlierDatabase.schemaDigest,
            },
          ],
        },
      },
      manifestSha256: 'b'.repeat(64),
    };
    const rollbackStartingPoint = {
      ...upgraded.manifest,
      databaseSchemaDigest: rollbackSource.manifest.database.schemaDigest,
      platformVersion: rollbackSource.manifest.platformVersion,
      runtime: {
        manifestSha256: rollbackSource.manifestSha256,
        source: rollbackSource.source,
        sourceRevision: rollbackSource.manifest.sourceRevision,
      },
    };
    const verifiedRollbackSchemas: Array<string> = [];
    const rollbackResult = await installPlatform(upgradedPlan, secrets, rollbackStartingPoint, {
      acquireDatabaseLifecycleLock: async () =>
        Object.assign(async () => {}, {
          prepareSandboxDrain: async () => sandboxDrainPreparation('complete'),
          verifyDatabase: async (
            _runtimeDirectory: string,
            database: PlatformRuntimeDatabaseManifest,
          ) => {
            verifiedRollbackSchemas.push(database.schemaDigest);
          },
        }),
      claimDatabase,
      client: upgradeClient,
      databaseRollbackSource: rollbackSource,
      deployWorker: async () => {},
      revalidateBeforeWorkerDeploy: async () => {},
      runtime: earlierRuntime,
      verifyHealth: async () => {},
    });
    expect(verifiedRollbackSchemas).toEqual([rollbackSource.manifest.database.schemaDigest]);
    expect(rollbackResult.manifest).toMatchObject({
      databaseSchemaDigest: rollbackSource.manifest.database.schemaDigest,
      platformVersion: earlierRuntime.manifest.platformVersion,
      runtime: { manifestSha256: earlierRuntime.manifestSha256 },
    });

    const cleanMachineDiscovery = parsePlatformInstallationManifest(
      JSON.parse(JSON.stringify(rollbackResult.manifest)),
    );
    expect(cleanMachineDiscovery.databaseSchemaDigest).toBe(
      rollbackSource.manifest.database.schemaDigest,
    );
    expect(cleanMachineDiscovery.runtime?.manifestSha256).toBe(earlierRuntime.manifestSha256);

    const verifiedRollForwardSchemas: Array<string> = [];
    const rollForwardResult = await installPlatform(upgradedPlan, secrets, cleanMachineDiscovery, {
      acquireDatabaseLifecycleLock: async () =>
        Object.assign(async () => {}, {
          prepareSandboxDrain: async () => sandboxDrainPreparation('complete'),
          verifyDatabase: async (
            _runtimeDirectory: string,
            database: PlatformRuntimeDatabaseManifest,
          ) => {
            verifiedRollForwardSchemas.push(database.schemaDigest);
          },
        }),
      claimDatabase,
      client: upgradeClient,
      deployWorker: async () => {},
      revalidateBeforeWorkerDeploy: async () => {},
      runtime: rollbackSource,
      verifyHealth: async () => {},
    });
    expect(verifiedRollForwardSchemas).toEqual([rollbackSource.manifest.database.schemaDigest]);
    expect(rollForwardResult.manifest).toMatchObject({
      databaseSchemaDigest: rollbackSource.manifest.database.schemaDigest,
      platformVersion: rollbackSource.manifest.platformVersion,
      runtime: { manifestSha256: rollbackSource.manifestSha256 },
    });
  });

  it('downgrades the usage protocol behind the routing gate', async () => {
    const { secrets, deployment, upgradedPlan, upgradeClient, upgraded } = await upgradedPlatform();
    const currentRuntime = resolvePlatformRuntime(getPlatformRuntimeDirectory());
    const downgradeEvents: Array<string> = [];
    const downgraded = await installPlatform(upgradedPlan, secrets, upgraded.manifest, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: {
        ...upgradeClient,
        deleteKvValue: async (_account, _namespace, key) => {
          if (key === PLATFORM_DISABLED_KEY) {
            downgradeEvents.push('gate:open');
          }
        },
        putKvValue: async (_account, _namespace, key) => {
          if (key === PLATFORM_DISABLED_KEY) {
            downgradeEvents.push('gate:closed');
          }
        },
      },
      deployWorker: async (config) => {
        downgradeEvents.push(`deploy:${String(config.name)}`);
      },
      prepareDatabase,
      revalidateBeforeWorkerDeploy: async () => {},
      runtime: {
        ...currentRuntime,
        manifest: { ...currentRuntime.manifest, usageProtocolVersion: 0 },
      },
      verifyHealth: async () => {
        downgradeEvents.push('health');
      },
      verifyWorkerCutover: async () => {
        downgradeEvents.push('cutover');
      },
    });
    expect(downgradeEvents[0]).toBe('gate:closed');
    expect(downgradeEvents.filter((event) => event.startsWith('deploy:'))).toHaveLength(10);
    expect(downgradeEvents.indexOf('gate:open')).toBeGreaterThan(
      downgradeEvents.lastIndexOf(`deploy:${deployment.resources.dispatchWorker}`),
    );
    expect(downgradeEvents.indexOf('gate:open')).toBeGreaterThan(
      downgradeEvents.indexOf('cutover'),
    );
    expect(downgraded.manifest.usageProtocolVersion).toBe(0);
  });

  it('recreates a missing Worker behind the routing gate', async () => {
    const { secrets, upgradedPlan, upgradeClient, upgraded } = await upgradedPlatform();
    const repairedWorkerConfigs: Array<Record<string, unknown>> = [];
    const repairEvents: Array<string> = [];
    const repairPlan = {
      ...upgradedPlan,
      actions: upgradedPlan.actions.map((action) =>
        action.key === 'api-worker'
          ? {
              ...action,
              action: 'create' as const,
              id: null,
              reason: 'Recreate the missing installer-owned Worker.',
            }
          : action,
      ),
    };
    await installPlatform(repairPlan, secrets, upgraded.manifest, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: {
        ...upgradeClient,
        deleteKvValue: async (_account, _namespace, key) => {
          if (key === PLATFORM_DISABLED_KEY) {
            repairEvents.push('gate:open');
          }
        },
        putKvValue: async (_account, _namespace, key) => {
          if (key === PLATFORM_DISABLED_KEY) {
            repairEvents.push('gate:closed');
          }
        },
      },
      deployWorker: async (config) => {
        repairedWorkerConfigs.push(config);
        repairEvents.push(`deploy:${String(config.name)}`);
      },
      prepareDatabase,
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {
        repairEvents.push('health');
      },
      verifyWorkerCutover: async () => {
        repairEvents.push('cutover');
      },
    });
    expect(repairEvents[0]).toBe('gate:closed');
    expect(repairEvents.indexOf('gate:closed')).toBeLessThan(
      repairEvents.findIndex((event) => event.startsWith('deploy:')),
    );
    expect(repairEvents.indexOf('gate:open')).toBeGreaterThan(repairEvents.indexOf('cutover'));
    expect(repairEvents.indexOf('gate:open')).toBeGreaterThan(repairEvents.indexOf('health'));
    expect(repairEvents.indexOf('gate:open')).toBeGreaterThan(
      Math.max(
        ...repairEvents.flatMap((event, index) => (event.startsWith('deploy:') ? [index] : [])),
      ),
    );
    expect(repairedWorkerConfigs).toHaveLength(10);
    for (const index of [0, 1, 2, 4]) {
      expect(
        (repairedWorkerConfigs[index]!.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE,
      ).toBe('staging');
      expect(
        (repairedWorkerConfigs[index + 5]!.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE,
      ).toBe('enabled');
    }
  });

  it('defers sandbox drain verification of a disabled legacy upgrade until enablement', async () => {
    const { secrets, upgradedPlan, upgradeClient, upgraded } = await upgradedPlatform();
    const legacyDisabled = {
      ...setInstallationDesiredState(upgraded.manifest, 'disabled', '2026-09-14T00:00:03.500Z'),
      safetyProtocols: { sandboxDrain: 0 as const },
      status: 'disabled' as const,
    };
    const disabledLegacyUpgrade = await installPlatform(upgradedPlan, secrets, legacyDisabled, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: upgradeClient,
      deployWorker: async () => {},
      prepareDatabase,
      prepareSandboxDrain: async () => sandboxDrainPreparation('pending'),
      revalidateBeforeWorkerDeploy: async () => {},
      verifySandboxDrain: async () => {
        throw new Error('a disabled upgrade must defer drain verification until enablement');
      },
    });
    expect(disabledLegacyUpgrade.manifest).toMatchObject({
      desiredState: 'disabled',
      safetyProtocols: { sandboxDrain: 3 },
      status: 'disabled',
    });

    const legacyEnableConfigs: Array<Record<string, unknown>> = [];
    let legacyEnableGateOpened = false;
    const legacyEnableResult = await installPlatform(
      upgradedPlan,
      secrets,
      setInstallationDesiredState(
        disabledLegacyUpgrade.manifest,
        'enabled',
        '2026-09-14T00:00:03.750Z',
      ),
      {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: {
          ...upgradeClient,
          deleteKvValue: async () => {
            legacyEnableGateOpened = true;
          },
        },
        deployWorker: async (config) => {
          legacyEnableConfigs.push(config);
        },
        prepareDatabase,
        prepareSandboxDrain: async () => sandboxDrainPreparation('pending'),
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {},
        verifySandboxDrain: async () => false,
      },
    );
    expect(legacyEnableResult.waitingForSandboxDrain).toBe(true);
    expect(legacyEnableGateOpened).toBe(false);
    expect(legacyEnableConfigs).toHaveLength(5);
    for (const index of [0, 1, 2, 4]) {
      expect(
        (legacyEnableConfigs[index]!.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE,
      ).toBe('sandbox-drain');
    }
  });

  it('keeps a disabled upgrade off public routes through an interrupted deployment', async () => {
    const {
      disabledConfigs,
      disabledHealthChecks,
      disabledUpgrade,
      failedDisabledUpgrade,
      interrupted,
      resumedConfigs,
      resumedDisabledUpgrade,
    } = await disabledPlatform();
    expect(disabledUpgrade.manifest.status).toBe('disabled');
    expect(disabledHealthChecks).toBe(0);
    expect(disabledConfigs).toHaveLength(5);
    for (const config of disabledConfigs) {
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config).not.toHaveProperty('routes');
    }
    expect(interrupted).toBe(true);
    expect(failedDisabledUpgrade.status).toBe('failed');
    expect(failedDisabledUpgrade.desiredState).toBe('disabled');
    expect(resumedDisabledUpgrade.manifest.status).toBe('disabled');
    expect(resumedConfigs).toHaveLength(5);
    for (const config of resumedConfigs) {
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config).not.toHaveProperty('routes');
    }
  });

  it('closes the routing gate again when a Worker changes during enablement', async () => {
    const { secrets, upgradedPlan, upgradeClient, resumedDisabledUpgrade } =
      await disabledPlatform();
    const concurrentEnableEvents: Array<string> = [];
    let cutoverVerifications = 0;
    await expect(
      installPlatform(
        upgradedPlan,
        secrets,
        setInstallationDesiredState(
          resumedDisabledUpgrade.manifest,
          'enabled',
          '2026-09-14T00:00:04.250Z',
        ),
        {
          acquireDatabaseLifecycleLock,
          claimDatabase,
          client: {
            ...upgradeClient,
            deleteKvValue: async (_account, _namespace, key) => {
              concurrentEnableEvents.push(`delete:${key}`);
            },
            putKvValue: async (_account, _namespace, key) => {
              if (key === PLATFORM_DISABLED_KEY) {
                concurrentEnableEvents.push(`put:${key}`);
              }
            },
          },
          deployWorker: async () => async () => {},
          prepareDatabase,
          revalidateBeforeWorkerDeploy: async () => {},
          verifyHealth: async () => {},
          verifyWorkerCutover: async () => {
            cutoverVerifications++;
            if (cutoverVerifications === 2) {
              throw new Error('platform: API Worker changed concurrently.');
            }
          },
        },
      ),
    ).rejects.toThrow('API Worker changed concurrently');
    expect(cutoverVerifications).toBe(2);
    expect(concurrentEnableEvents.slice(-2)).toEqual([
      `delete:${PLATFORM_DISABLED_KEY}`,
      `put:${PLATFORM_DISABLED_KEY}`,
    ]);
  });

  it('retries a failed enablement from the recorded previous Worker configs', async () => {
    const { directory, secrets, deployment, upgradedPlan, upgradeClient, resumedDisabledUpgrade } =
      await disabledPlatform();
    const failedEnableEvents: Array<string> = [];
    let failedEnableDeploys = 0;
    await expect(
      installPlatform(
        upgradedPlan,
        secrets,
        setInstallationDesiredState(
          resumedDisabledUpgrade.manifest,
          'enabled',
          '2026-09-14T00:00:04.500Z',
        ),
        {
          acquireDatabaseLifecycleLock,
          claimDatabase,
          client: upgradeClient,
          deployWorker: async (config) => {
            const deploymentIndex = ++failedEnableDeploys;
            failedEnableEvents.push(`deploy:${deploymentIndex}:${String(config.name)}`);
            if (deploymentIndex === 7) {
              throw new Error('generation 2 deployment failed');
            }
            return async () => {
              failedEnableEvents.push(`rollback:${deploymentIndex}:${String(config.name)}`);
              if (deploymentIndex === 6) {
                throw new Error('generation 2 rollback failed');
              }
            };
          },
          prepareDatabase,
          revalidateBeforeWorkerDeploy: async () => {},
          verifyHealth: async () => {},
        },
      ),
    ).rejects.toThrow(
      'generation 2 deployment failed Automatic Worker rollback was incomplete: generation 2 rollback failed',
    );
    expect(failedEnableEvents.filter((event) => event.startsWith('rollback:'))).toEqual([
      `rollback:6:${deployment.resources.apiWorker}`,
    ]);

    const failedEnableManifest = listInstallationManifests(directory)[0]!;
    const retryPreviousConfigs: Array<Record<string, unknown>> = [];
    const retriedEnable = await installPlatform(upgradedPlan, secrets, failedEnableManifest, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: upgradeClient,
      deployWorker: async (_config, _secrets, previousConfig) => {
        retryPreviousConfigs.push(previousConfig);
      },
      prepareDatabase,
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
    });
    expect(retriedEnable.manifest.status).toBe('installed');
    expect(retryPreviousConfigs).toHaveLength(10);
    expect(retryPreviousConfigs.slice(0, 5).every((config) => config.workers_dev === false)).toBe(
      true,
    );
    expect(
      retryPreviousConfigs
        .slice(5)
        .every(
          (config) => config.workers_dev === (config.name !== deployment.resources.tailWorker),
        ),
    ).toBe(true);
    expect(
      retryPreviousConfigs
        .slice(5)
        .filter((config) => !String(config.name).endsWith('-tail'))
        .every(
          (config) => (config.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE === 'staging',
        ),
    ).toBe(true);
  });

  it('enables a disabled upgrade after staging every Worker', async () => {
    const { deletedKvValues, deployment, enabledConfigs, enabledHealthChecks, enabledUpgrade } =
      await enabledPlatform();
    expect(enabledUpgrade.manifest.status).toBe('installed');
    expect(enabledUpgrade.manifest.desiredState).toBe('enabled');
    expect(enabledUpgrade.manifest.deployment.authentication.configurable).toBe(true);
    expect(enabledHealthChecks).toBe(2);
    expect(deletedKvValues).toContain('__void/platform/disabled/v1');
    expect(enabledConfigs).toHaveLength(10);
    for (const config of enabledConfigs.slice(0, 5)) {
      expect((config.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE).not.toBe('enabled');
    }
    for (const config of enabledConfigs.slice(5)) {
      expect(config.workers_dev).toBe(config.name !== deployment.resources.tailWorker);
      expect(config.preview_urls).toBe(
        config.name !== deployment.resources.emailGatewayWorker &&
          config.name !== deployment.resources.tailWorker,
      );
      if (!String(config.name).endsWith('-tail')) {
        expect((config.vars as Record<string, unknown>).PLATFORM_TRAFFIC_STATE).toBe('enabled');
      }
    }
    expect(
      enabledConfigs.slice(5).find((config) => config.name === deployment.resources.dispatchWorker),
    ).toHaveProperty('routes');
  });

  it('rolls back a disabling upgrade without exposing workers.dev', async () => {
    const { secrets, upgradedPlan, upgradeClient, enabledUpgrade } = await enabledPlatform();
    const disabledRollbackStates: Array<unknown> = [];
    let disabledRollbackDeploys = 0;
    await expect(
      installPlatform(
        upgradedPlan,
        secrets,
        {
          ...setInstallationDesiredState(
            enabledUpgrade.manifest,
            'disabled',
            '2026-09-14T00:00:05.500Z',
          ),
          status: 'disabled',
        },
        {
          acquireDatabaseLifecycleLock,
          claimDatabase,
          client: upgradeClient,
          deployWorker: async (_config, _secrets, previousConfig) => {
            disabledRollbackStates.push(previousConfig.workers_dev);
            disabledRollbackDeploys++;
            if (disabledRollbackDeploys === 2) {
              throw new Error('disabled upgrade failed');
            }
            return async () => {};
          },
          prepareDatabase,
          revalidateBeforeWorkerDeploy: async () => {},
        },
      ),
    ).rejects.toThrow('disabled upgrade failed');
    expect(disabledRollbackStates).toEqual([false, false]);
  });

  it('does not deploy when a Worker ownership marker changed after planning', async () => {
    const { secrets, upgradedPlan, upgradeClient, enabledUpgrade } = await enabledPlatform();
    let replacedWorkerDeploys = 0;
    await expect(
      installPlatform(upgradedPlan, secrets, enabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async () => {
          replacedWorkerDeploys++;
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {
          throw new Error('platform: Worker ownership marker changed after planning.');
        },
      }),
    ).rejects.toThrow('ownership marker changed after planning');
    expect(replacedWorkerDeploys).toBe(0);
  });

  it('rolls back deployed Workers in reverse order when one deploy fails', async () => {
    const { secrets, deployment, upgradedPlan, upgradeClient, enabledUpgrade } =
      await enabledPlatform();
    const partialEvents: Array<string> = [];
    let partialDeploys = 0;
    await expect(
      installPlatform(upgradedPlan, secrets, enabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          const name = String(config.name);
          partialDeploys++;
          partialEvents.push(`deploy:${name}`);
          if (partialDeploys === 3) {
            throw new Error('third Worker failed');
          }
          return async () => {
            partialEvents.push(`rollback:${name}`);
          };
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
      }),
    ).rejects.toThrow('third Worker failed');
    expect(partialEvents).toEqual([
      `deploy:${deployment.resources.apiWorker}`,
      `deploy:${deployment.resources.proxyWorker}`,
      `deploy:${deployment.resources.emailGatewayWorker}`,
      `rollback:${deployment.resources.proxyWorker}`,
      `rollback:${deployment.resources.apiWorker}`,
    ]);
  });

  it('rolls back every Worker in reverse order when health fails', async () => {
    const { secrets, deployment, upgradedPlan, upgradeClient, enabledUpgrade } =
      await enabledPlatform();
    const healthEvents: Array<string> = [];
    await expect(
      installPlatform(upgradedPlan, secrets, enabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async (config) => {
          const name = String(config.name);
          healthEvents.push(`deploy:${name}`);
          return async () => {
            healthEvents.push(`rollback:${name}`);
          };
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          throw new Error('health check failed');
        },
      }),
    ).rejects.toThrow('health check failed');
    expect(healthEvents.slice(-5)).toEqual([
      `rollback:${deployment.resources.dispatchWorker}`,
      `rollback:${deployment.resources.tailWorker}`,
      `rollback:${deployment.resources.emailGatewayWorker}`,
      `rollback:${deployment.resources.proxyWorker}`,
      `rollback:${deployment.resources.apiWorker}`,
    ]);
  });

  it('attempts every rollback and reports an incomplete one', async () => {
    const { secrets, upgradedPlan, upgradeClient, enabledUpgrade } = await enabledPlatform();
    let rollbackIndex = 0;
    await expect(
      installPlatform(upgradedPlan, secrets, enabledUpgrade.manifest, {
        acquireDatabaseLifecycleLock,
        claimDatabase,
        client: upgradeClient,
        deployWorker: async () => async () => {
          rollbackIndex++;
          if (rollbackIndex === 2) {
            throw new Error('rollback unavailable');
          }
        },
        prepareDatabase,
        revalidateBeforeWorkerDeploy: async () => {},
        verifyHealth: async () => {
          throw new Error('health check failed');
        },
      }),
    ).rejects.toThrow(
      'health check failed Automatic Worker rollback was incomplete: rollback unavailable',
    );
    expect(rollbackIndex).toBe(5);
  });

  it('restores an interrupted cutover behind the routing gate before the next one', async () => {
    const { secrets, deployment, upgradedPlan, upgradeClient, enabledUpgrade } =
      await enabledPlatform();
    const interruptedCutover = {
      ...enabledUpgrade.manifest,
      status: 'failed' as const,
      steps: [
        ...enabledUpgrade.manifest.steps,
        {
          completedAt: '2026-09-14T00:00:06.000Z',
          key: 'worker-cutover:999:staged:emailGateway',
          resultHash: cutoverSnapshot(
            deployment.resources.emailGatewayWorker,
            'previous-email',
            'staged-email',
          ),
        },
        {
          completedAt: '2026-09-14T00:00:06.000Z',
          key: 'worker-cutover:999:staged:api',
          resultHash: cutoverSnapshot(deployment.resources.apiWorker, 'previous-api', 'staged-api'),
        },
        {
          completedAt: '2026-09-14T00:00:06.000Z',
          key: 'worker-cutover:999:staged:proxy',
          resultHash: cutoverSnapshot(
            deployment.resources.proxyWorker,
            'previous-proxy',
            'staged-proxy',
          ),
        },
        {
          completedAt: '2026-09-14T00:00:06.000Z',
          key: 'worker-cutover:999:unsafe-traffic:emailGateway',
          resultHash: deployment.resources.emailGatewayWorker,
        },
        {
          completedAt: '2026-09-14T00:00:06.000Z',
          key: 'worker-cutover:999:unsafe-traffic:proxy',
          resultHash: deployment.resources.proxyWorker,
        },
      ],
    };
    const recoveryEvents: Array<string> = [];
    const recovered = await installPlatform(upgradedPlan, secrets, interruptedCutover, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: {
        ...upgradeClient,
        deleteKvValue: async (_account, _namespace, key) => {
          recoveryEvents.push(`delete:${key}`);
        },
        putKvValue: async (_account, _namespace, key) => {
          if (key === PLATFORM_DISABLED_KEY) {
            recoveryEvents.push(`put:${key}`);
          }
        },
      },
      deployWorker: async (config) => {
        recoveryEvents.push(`deploy:${String(config.name)}`);
      },
      prepareDatabase,
      recoverWorkerCutover: async (snapshot) => {
        recoveryEvents.push(
          `recover:${snapshot.key}:${snapshot.previousVersionId}:${snapshot.stagedVersionId}:${snapshot.preserveCustomDomains}`,
        );
      },
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: async () => {},
      verifyWorkerCutover: async () => {
        recoveryEvents.push('verify-cutover');
      },
    });
    expect(recoveryEvents.slice(0, 4)).toEqual([
      `put:${PLATFORM_DISABLED_KEY}`,
      'recover:emailGateway:previous-email:staged-email:true',
      'recover:proxy:previous-proxy:staged-proxy:true',
      'recover:api:previous-api:staged-api:false',
    ]);
    expect(recoveryEvents.filter((event) => event === 'verify-cutover')).toHaveLength(2);
    expect(recoveryEvents.indexOf('verify-cutover')).toBeLessThan(
      recoveryEvents.indexOf(`delete:${PLATFORM_DISABLED_KEY}`),
    );
    expect(recovered.manifest.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'worker-cutover:999:restored' }),
        expect.objectContaining({ key: 'worker-traffic-state:999', resultHash: 'disabled' }),
        expect.objectContaining({ key: 'worker-cutover:1000:committed' }),
      ]),
    );
  });

  it('replans Workers after an interrupted initial cutover', async () => {
    const { secrets, deployment, upgradedPlan, upgradeClient, enabledUpgrade } =
      await enabledPlatform();
    const interruptedInitialCutover = {
      ...enabledUpgrade.manifest,
      status: 'failed' as const,
      steps: [
        ...enabledUpgrade.manifest.steps,
        {
          completedAt: '2026-09-14T00:00:07.000Z',
          key: 'worker-cutover:2000:staged:api',
          resultHash: cutoverSnapshot(deployment.resources.apiWorker, null, 'staged-api'),
        },
      ],
    };
    let replannedResourceState = '';
    const replannedActions: Array<string> = [];
    const interruptedInitialGateWrites: Array<string> = [];
    await installPlatform(upgradedPlan, secrets, interruptedInitialCutover, {
      acquireDatabaseLifecycleLock,
      claimDatabase,
      client: {
        ...upgradeClient,
        putKvValue: async (_account, _namespace, key) => {
          if (key === PLATFORM_DISABLED_KEY) {
            interruptedInitialGateWrites.push(key);
          }
        },
      },
      deployWorker: async () => {},
      prepareDatabase,
      recoverWorkerCutover: async () => {},
      replanWorkers: async (manifest) => {
        replannedResourceState = manifest.resources.find(
          (resource) => resource.key === 'api-worker',
        )!.state;
        return upgradedPlan.actions
          .filter((action) => action.kind === 'worker')
          .map((action) =>
            action.key === 'api-worker' ? { ...action, action: 'reuse', id: action.name } : action,
          );
      },
      revalidateBeforeWorkerDeploy: async (_manifest, action) => {
        replannedActions.push(`${action.key}:${action.action}`);
      },
      verifyHealth: async () => {},
    });
    expect(interruptedInitialGateWrites).toEqual([PLATFORM_DISABLED_KEY]);
    expect(replannedResourceState).toBe('ready');
    expect(replannedActions).toContain('api-worker:reuse');
  });
});

function migrationSubset(length: number): PlatformRuntimeDatabaseManifest {
  const database = readPlatformRuntimeManifest().database;
  const migrations = database.migrations.slice(0, length);
  return {
    ...database,
    migrations,
    rollbackSafeFrom: [],
    schemaDigest: platformDatabaseSchemaDigest(database.lineage, migrations),
  };
}

function migrationConnection(
  initialRows: Array<{ created_at: unknown; hash: unknown; id: unknown }> = [],
  failSql = '',
) {
  let relationExists = initialRows.length > 0;
  let transactionRows: Array<{ created_at: unknown; hash: unknown; id: unknown }> | null = null;
  let transactionRelation = false;
  const rows = [...initialRows];
  const queries: Array<string> = [];
  const result = <Row extends Record<string, unknown>>(value: ReadonlyArray<unknown>) => ({
    rows: value as ReadonlyArray<Row>,
  });
  return {
    queries,
    rows,
    query: async <Row extends Record<string, unknown>>(
      sql: string,
      values?: ReadonlyArray<unknown>,
    ) => {
      queries.push(sql.trim());
      if (sql === 'BEGIN') {
        transactionRows = rows.map((row) => ({ ...row }));
        transactionRelation = relationExists;
      } else if (sql === 'ROLLBACK') {
        rows.splice(0, rows.length, ...(transactionRows ?? []));
        relationExists = transactionRelation;
        transactionRows = null;
      } else if (sql === 'COMMIT') {
        transactionRows = null;
      } else if (sql.includes('to_regclass')) {
        return result<Row>([{ relation: relationExists ? 'drizzle.__drizzle_migrations' : null }]);
      } else if (sql.includes('FROM "drizzle"."__drizzle_migrations"')) {
        return result<Row>(
          [...rows].sort(
            (left, right) =>
              Number(left.created_at) - Number(right.created_at) ||
              Number(left.id) - Number(right.id),
          ),
        );
      } else if (sql.includes('CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"')) {
        relationExists = true;
      } else if (sql.includes('INSERT INTO "drizzle"."__drizzle_migrations"')) {
        rows.push({ created_at: values?.[1], hash: values?.[0], id: rows.length + 1 });
      } else if (failSql && sql.includes(failSql)) {
        throw new Error('migration failed');
      }
      return result<Row>([]);
    },
  };
}
