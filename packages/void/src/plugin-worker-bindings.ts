import { appendSqliteClassMigration } from '@void/deploy-core';
import { type ApplicationAnalysis } from './application-analysis.ts';
import { SEND_EMAIL_BINDING } from './cli/email-cloudflare.ts';
import {
  findBindingNameOwner,
  hasDurableObjectSqliteMigration,
  LIVE_MIGRATION_TAG,
  nextDurableObjectMigrationTag,
  resolveLiveBindingConfig,
} from './cli/wrangler.ts';
import { finalizeDurableObjectPatch } from './cloudflare-durable-patch.ts';
import { readConfig } from './config.ts';
import {
  resolveWorkersAiBindingName,
  shouldBindWorkersAi,
  readVoidDevCredentials,
} from './plugin-ai-setup.ts';
import { hasBinding, shouldInjectEmailDevInboxVar } from './plugin-binding-utils.ts';
import { type WorkerConfig } from './plugin-cloudflare-config.ts';
import { type EnvSchemaFacts } from './plugin-env-schema.ts';
import { isRouteEnabledForEnvironment, type RouteEnvironment } from './router/parse-filename.ts';
import { DEV_INBOX_ENV_VAR, DEV_INBOX_TOKEN_ENV_VAR } from './runtime/email/dev-inbox.ts';
import {
  SANDBOX_MIGRATION_TAG,
  hasSandboxSqliteMigration,
  resolveSandboxConfig,
  sandboxContainerConfig,
  assertSandboxNamespaceConfig,
} from './sandbox/config.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from './shared/env.ts';
import {
  CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV,
  selectNativeVersionMetadataBinding,
} from './shared/version-metadata.ts';

type DurableObjectBinding = { name: string; class_name: string };
type DurableObjectMigration = {
  tag?: string;
  new_classes?: Array<string>;
  new_sqlite_classes?: Array<string>;
};

/** Durable Object bindings already in the patch, else in the resolved config. */
function currentDurableObjectBindings(
  result: Record<string, unknown>,
  resolved: WorkerConfig,
): Array<DurableObjectBinding> {
  const current = (result.durable_objects ??
    (resolved as Record<string, unknown>).durable_objects) as
    | { bindings?: Array<DurableObjectBinding> }
    | undefined;
  return current?.bindings ?? [];
}

/** Migrations already in the patch, else in the resolved config. */
function currentMigrations(
  result: Record<string, unknown>,
  resolved: WorkerConfig,
): Array<DurableObjectMigration> {
  const current = result.migrations ?? (resolved as Record<string, unknown>).migrations;
  return Array.isArray(current) ? (current as Array<DurableObjectMigration>) : [];
}

export function mergeWorkerBindings(
  resolved: WorkerConfig,
  input: {
    readonly websocketRoutes: ApplicationAnalysis['allWebsockets'];
    readonly routeEnvironment: RouteEnvironment;
    readonly workerConfig: Record<string, unknown>;
    readonly envSchemaFacts: EnvSchemaFacts | undefined;
    readonly authEnabled: boolean;
    readonly viteCommand: 'serve' | 'build';
    readonly bindingNames: ApplicationAnalysis['bindingNames'];
    readonly dialect: ApplicationAnalysis['dialect'];
    readonly application: ApplicationAnalysis;
    readonly bindings: ApplicationAnalysis['bindings'];
    readonly directCloudflareDestination: boolean;
    readonly config: ReturnType<typeof readConfig>;
    readonly devTriggerToken: string;
    readonly queues: ApplicationAnalysis['queues'];
    readonly durableObjects: ApplicationAnalysis['durableObjects'];
    readonly sandboxConfig: ReturnType<typeof resolveSandboxConfig> | undefined;
    readonly shouldEmitLive: () => boolean;
    readonly liveConfig: ReturnType<typeof resolveLiveBindingConfig> | undefined;
    readonly root: string;
    readonly remoteMode: boolean;
  },
): { patch: Partial<WorkerConfig>; versionMetadataBinding: string | undefined } {
  const {
    websocketRoutes,
    routeEnvironment,
    workerConfig,
    envSchemaFacts,
    authEnabled,
    viteCommand,
    bindingNames,
    dialect,
    application,
    bindings,
    directCloudflareDestination,
    config,
    devTriggerToken,
    queues,
    durableObjects,
    sandboxConfig,
    shouldEmitLive,
    liveConfig,
    root,
    remoteMode,
  } = input;

  const environmentWebsocketRoutes = websocketRoutes.filter((route) =>
    isRouteEnabledForEnvironment(route, routeEnvironment),
  );
  const result: Record<string, unknown> = { ...workerConfig };

  // The Cloudflare plugin defu-merges this patch over resolved, concatenating arrays.
  // Flags read from the root config therefore occur in both inputs. Emit their union
  // once and clear only the in-memory fallback so uploads never repeat a flag.
  result.compatibility_flags = [
    ...new Set([
      ...((result.compatibility_flags as Array<string> | undefined) ?? []),
      ...(resolved.compatibility_flags ?? []),
    ]),
  ];
  resolved.compatibility_flags = [];

  if (envSchemaFacts || (authEnabled && process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] === '1')) {
    const plaintextVars = {
      ...((resolved.vars as Record<string, unknown> | undefined) ?? {}),
      ...((result.vars as Record<string, unknown> | undefined) ?? {}),
    };
    const plaintextServerKeys = (envSchemaFacts?.serverKeys ?? []).filter(
      (key) => key in plaintextVars,
    );
    if (viteCommand === 'build' && plaintextServerKeys.length > 0) {
      throw new Error(
        `Server env keys cannot be Worker plaintext vars: ${plaintextServerKeys.join(', ')}. ` +
          'Remove them from worker.vars/wrangler vars and set them with the remote secret store.',
      );
    }
    const configuredRequired = resolved.secrets?.required ?? [];
    const required = [
      ...new Set([
        ...configuredRequired,
        ...(envSchemaFacts?.requiredServerKeys ?? []),
        ...(authEnabled && process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] === '1'
          ? ['BETTER_AUTH_SECRET']
          : []),
      ]),
    ];
    if (required.length > 0) {
      result.secrets = { required };
    }
  }

  // Void owns the generated asset routing policy. Replace stale root
  // wrangler settings instead of letting the Cloudflare plugin concatenate
  // them with generated rules. This preserves static-first behavior for
  // API-only apps while avoiding asset-served HTML bypassing middleware.
  if (workerConfig.assets && resolved.assets) {
    delete (resolved.assets as Record<string, unknown>).not_found_handling;
    delete (resolved.assets as Record<string, unknown>).run_worker_first;
  }

  // D1 — auth requires the app DB only for sqlite apps
  const d1Name = bindingNames?.d1 ?? 'DB';
  const d1: Array<Record<string, unknown>> = [];
  if (
    dialect === 'sqlite' &&
    application.needsDatabase &&
    !hasBinding(resolved.d1_databases, d1Name)
  ) {
    d1.push({ binding: d1Name, database_name: 'default', database_id: 'local' });
  }
  if (d1.length > 0) {
    result.d1_databases = d1;
  }

  const kvName = bindingNames?.kv ?? 'KV';
  const kv: Array<{ binding: string; id: string }> = [];
  if (bindings.needsKV && !hasBinding(resolved.kv_namespaces, kvName)) {
    kv.push({ binding: kvName, id: 'local' });
  }
  if (kv.length > 0) {
    result.kv_namespaces = kv;
  }

  // R2
  const r2Name = bindingNames?.r2 ?? 'STORAGE';
  if (bindings.needsR2 && !hasBinding(resolved.r2_buckets, r2Name)) {
    result.r2_buckets = [{ binding: r2Name, bucket_name: 'default' }];
  }

  // Workers AI has no local simulator, so direct Cloudflare dev uses the remote
  // binding; an authored root binding only gains `remote: true`. Managed and
  // unsaved dev projects use the Void proxy below.
  const resolvedAi = (resolved as { ai?: unknown }).ai;
  const aiBindingName = resolveWorkersAiBindingName(resolvedAi, bindingNames?.ai);
  if (
    viteCommand === 'serve' &&
    bindings.needsAI &&
    directCloudflareDestination &&
    typeof resolvedAi === 'object' &&
    resolvedAi !== null &&
    'binding' in resolvedAi &&
    typeof resolvedAi.binding === 'string'
  ) {
    result.ai = { ...resolvedAi, remote: true };
  } else if (
    shouldBindWorkersAi(
      viteCommand,
      bindings.needsAI,
      resolvedAi,
      result.ai,
      directCloudflareDestination,
    )
  ) {
    result.ai = {
      binding: aiBindingName,
      ...(viteCommand === 'serve' && { remote: true }),
    };
  }

  // AI binding name / Gateway id → runtime vars (harmless in serve; only read
  // by the direct backend). The default binding needs no extra variable.
  if (aiBindingName !== 'AI' || config.ai?.gateway) {
    const vars = (result.vars as Record<string, string>) ?? {};
    if (aiBindingName !== 'AI') {
      vars.__VOID_AI_BINDING = aiBindingName;
    }
    if (config.ai?.gateway) {
      vars.__VOID_AI_GATEWAY = config.ai.gateway;
    }
    result.vars = vars;
  }

  // This patch never adds a send binding. In dev, the inbox buffer lives in the
  // Vite process, so `sendEmail` loops back through the assets binding and
  // sends the dev-trigger token the inbox requires.
  const emailDevInboxBinding =
    (workerConfig.assets as { binding?: string } | undefined)?.binding ??
    (resolved.assets as { binding?: string } | undefined)?.binding;
  if (shouldInjectEmailDevInboxVar(routeEnvironment, bindings.needsEmail, emailDevInboxBinding)) {
    const vars = (result.vars as Record<string, string>) ?? {};
    vars[DEV_INBOX_ENV_VAR] = emailDevInboxBinding as string;
    vars[DEV_INBOX_TOKEN_ENV_VAR] = devTriggerToken;
    result.vars = vars;
  }

  // Serve with `void/email`: drop only the reserved SEND_EMAIL entry so the dev
  // inbox stays the only sink; other send_email bindings are the user's. The
  // patch is defu-merged over `resolved`, so mutating it is the only removal.
  if (viteCommand === 'serve' && bindings.needsEmail) {
    const sendEmail = (resolved as { send_email?: unknown }).send_email;
    if (Array.isArray(sendEmail)) {
      const kept = sendEmail.filter(
        (entry) => (entry as { name?: unknown } | null)?.name !== SEND_EMAIL_BINDING,
      );
      if (kept.length > 0) {
        (resolved as Record<string, unknown>).send_email = kept;
      } else {
        delete (resolved as Record<string, unknown>).send_email;
      }
    }
  }

  // Serve only: on build the root wrangler config owns __VOID_EMAIL_FROM, which
  // `void deploy --platform cloudflare` writes once the domain is ready.
  if (viteCommand === 'serve' && config.email?.from) {
    const vars = (result.vars as Record<string, string>) ?? {};
    vars.__VOID_EMAIL_FROM = config.email.from;
    result.vars = vars;
  }

  // Queues — add producer + consumer bindings for local dev
  if (queues.length > 0) {
    result.queues = {
      producers: queues.map((q) => ({ queue: q.name, binding: q.bindingName })),
      consumers: queues.map((q) => ({
        queue: q.name,
        ...(q.maxBatchSize != null && { max_batch_size: q.maxBatchSize }),
        ...(q.maxBatchTimeout != null && { max_batch_timeout: q.maxBatchTimeout }),
        ...(q.maxRetries != null && { max_retries: q.maxRetries }),
        ...(q.retryDelay != null && { retry_delay: q.retryDelay }),
      })),
    };
  }

  if (environmentWebsocketRoutes.length > 0) {
    const existingDurableObjectBindings =
      (resolved as { durable_objects?: { bindings?: Array<DurableObjectBinding> } }).durable_objects
        ?.bindings ?? [];
    for (const route of environmentWebsocketRoutes) {
      const conflict = existingDurableObjectBindings.find(
        (binding) => binding.name === route.bindingName && binding.class_name !== route.className,
      );
      if (conflict) {
        throw new Error(
          `websocket: binding '${route.bindingName}' is already configured for class '${conflict.class_name}', but '${route.filePath}' requires '${route.className}'.`,
        );
      }
    }
    const missingDurableObjectBindings = environmentWebsocketRoutes
      .filter(
        (route) =>
          !existingDurableObjectBindings.some((binding) => binding.name === route.bindingName),
      )
      .map((route) => ({
        name: route.bindingName,
        class_name: route.className,
      }));

    if (missingDurableObjectBindings.length > 0) {
      result.durable_objects = {
        bindings: [...existingDurableObjectBindings, ...missingDurableObjectBindings],
      };
    }

    const resolvedMigrations = (resolved as Record<string, unknown>).migrations;
    const planned = appendSqliteClassMigration(
      Array.isArray(resolvedMigrations) ? resolvedMigrations : [],
      environmentWebsocketRoutes.map((route) => route.className),
      'void-ws-v1',
      existingDurableObjectBindings.map((binding) => binding.class_name),
    );
    if (planned.added) {
      result.migrations = planned.migrations;
    }
  }

  if (durableObjects.length > 0) {
    const existingBindings = currentDurableObjectBindings(result, resolved);
    for (const module of durableObjects) {
      const conflict = existingBindings.find(
        (binding) => binding.name === module.bindingName && binding.class_name !== module.className,
      );
      if (conflict) {
        throw new Error(
          `durable: binding '${module.bindingName}' is already configured for class '${conflict.class_name}', but durable-objects/ requires '${module.className}'.`,
        );
      }
    }
    const additions = durableObjects
      .filter((module) => !existingBindings.some((binding) => binding.name === module.bindingName))
      .map((module) => ({ name: module.bindingName, class_name: module.className }));
    if (additions.length > 0) {
      result.durable_objects = {
        bindings: [...existingBindings, ...additions],
      };
    }

    const existingMigrations = currentMigrations(result, resolved);
    for (const module of durableObjects) {
      const tagConflict = existingMigrations.find(
        (migration) =>
          migration.tag === module.migrationTag &&
          !migration.new_sqlite_classes?.includes(module.className),
      );
      if (tagConflict) {
        throw new Error(
          `durable: migration tag '${module.migrationTag}' is already used by another Durable Object migration.`,
        );
      }
    }
    const migrationAdditions = durableObjects
      .filter(
        (module) =>
          !existingMigrations.some(
            (migration) =>
              migration.tag === module.migrationTag ||
              migration.new_sqlite_classes?.includes(module.className),
          ),
      )
      .map((module) => ({
        tag: module.migrationTag,
        new_sqlite_classes: [module.className],
      }));
    if (migrationAdditions.length > 0) {
      result.migrations = [...existingMigrations, ...migrationAdditions];
    }
  }

  if (bindings.needsSandbox && sandboxConfig) {
    assertSandboxNamespaceConfig({ ...resolved, ...result }, sandboxConfig);
    const existingDurableObjectBindings = currentDurableObjectBindings(result, resolved);
    if (!existingDurableObjectBindings.some((binding) => binding.name === sandboxConfig.binding)) {
      result.durable_objects = {
        bindings: [
          ...existingDurableObjectBindings,
          {
            name: sandboxConfig.binding,
            class_name: sandboxConfig.className,
          },
        ],
      };
    }

    const existingContainers =
      (result.containers as Array<{ class_name?: string }> | undefined) ??
      ((resolved as Record<string, unknown>).containers as
        | Array<{ class_name?: string }>
        | undefined) ??
      [];
    result.containers = [
      ...existingContainers.filter((container) => container.class_name !== sandboxConfig.className),
      sandboxContainerConfig(sandboxConfig),
    ];
    // Cloudflare concatenates callback arrays with the resolved config. This
    // patch already contains every existing Container, so emit the list once.
    (resolved as Record<string, unknown>).containers = [];

    const existingMigrations = currentMigrations(result, resolved);
    if (!hasSandboxSqliteMigration(existingMigrations, sandboxConfig.className)) {
      result.migrations = [
        ...existingMigrations,
        {
          tag: SANDBOX_MIGRATION_TAG,
          new_sqlite_classes: [sandboxConfig.className],
        },
      ];
    }
  }

  if (shouldEmitLive() && liveConfig) {
    const existingDurableObjectBindings = currentDurableObjectBindings(result, resolved);
    if (!existingDurableObjectBindings.some((binding) => binding.name === liveConfig.bindingName)) {
      result.durable_objects = {
        bindings: [
          ...existingDurableObjectBindings,
          {
            name: liveConfig.bindingName,
            class_name: liveConfig.className,
          },
        ],
      };
    }

    const existingMigrations = currentMigrations(result, resolved);
    if (!hasDurableObjectSqliteMigration(existingMigrations, liveConfig.className)) {
      result.migrations = [
        ...existingMigrations,
        {
          tag: nextDurableObjectMigrationTag(existingMigrations, LIVE_MIGRATION_TAG),
          new_sqlite_classes: [liveConfig.className],
        },
      ];
    }
  }

  // AI — in local dev, inject Void credentials for the HTTPS proxy path.
  // In production, the platform adds a __VOID_PROXY service binding instead.
  if (viteCommand === 'serve' && bindings.needsAI && !directCloudflareDestination) {
    const credentials = readVoidDevCredentials(root);
    if (credentials.status === 'ok') {
      // Prefer HTTPS proxy — inject credentials, skip direct AI binding
      const vars = (result.vars as Record<string, string>) ?? {};
      vars.__VOID_TOKEN = credentials.token;
      vars.__VOID_PROJECT_ID = credentials.projectId;
      vars.__VOID_PROXY_URL = credentials.proxyUrl;
      if (credentials.accessCredentials) {
        vars.__VOID_ACCESS_CREDENTIALS = credentials.accessCredentials;
      }
      result.vars = vars;
    }
  }

  // Remote bindings — inject proxy credentials when remote mode is enabled.
  // In remote mode, D1/KV/R2 bindings are replaced with proxy-backed versions
  // that forward operations to the platform proxy over HTTPS.
  if (
    viteCommand === 'serve' &&
    remoteMode &&
    (bindings.needsD1 || bindings.needsKV || bindings.needsR2)
  ) {
    const credentials = readVoidDevCredentials(root);
    if (credentials.status === 'ok') {
      const vars = (result.vars as Record<string, string>) ?? {};
      vars.__VOID_PROXY_URL = credentials.proxyUrl;
      if (credentials.accessCredentials) {
        vars.__VOID_ACCESS_CREDENTIALS = credentials.accessCredentials;
      }
      vars.__VOID_TOKEN = credentials.token;
      vars.__VOID_PROJECT_ID = credentials.projectId;
      vars.__VOID_REMOTE = '1';
      result.vars = vars;
    }
  }

  const versionMetadataBinding = selectNativeVersionMetadataBinding(
    resolved as Record<string, unknown>,
    {
      nativeBuild: viteCommand === 'build' && process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] === '1',
      preserveBindings: process.env[CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV] === '1',
    },
  );
  if (versionMetadataBinding) {
    const owner = findBindingNameOwner(result, 'version_metadata', versionMetadataBinding);
    if (owner) {
      throw new Error(
        `Cloudflare version metadata binding ${versionMetadataBinding} conflicts with ${owner}.`,
      );
    }
    if (!resolved.version_metadata) {
      result.version_metadata = { binding: versionMetadataBinding };
    }
  }
  finalizeDurableObjectPatch(resolved as Record<string, unknown>, result, [
    ...environmentWebsocketRoutes.map((route) => ({
      name: route.bindingName,
      class_name: route.className,
    })),
    ...durableObjects.map((module) => ({
      name: module.bindingName,
      class_name: module.className,
    })),
    ...(bindings.needsSandbox && sandboxConfig
      ? [{ name: sandboxConfig.binding, class_name: sandboxConfig.className }]
      : []),
    ...(shouldEmitLive() && liveConfig
      ? [{ name: liveConfig.bindingName, class_name: liveConfig.className }]
      : []),
  ]);
  return { patch: result as Partial<WorkerConfig>, versionMetadataBinding };
}
