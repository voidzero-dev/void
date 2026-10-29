export const SUPPORTED_MANIFEST_VERSIONS: ReadonlyArray<number> = [3, 4];

export type MigrationMeta = {
  name: string;
  destructive: boolean;
};

export type ScheduleMeta = {
  name: string;
  cron: string;
};

export type QueueMeta = {
  name: string;
  bindingName: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  retryDelay?: number;
};

export type HeaderRule = {
  pattern: string;
  headers: Array<[string, string]>;
};

/** Public wire shape of a redirect, rewrite, or fallback rule. */
export type RedirectRule = {
  source: string;
  destination: string;
  status: number;
  /** Lowercase literal hostname. Path-only rules omit this field. */
  host?: string;
};

export type AssetConfig = {
  not_found_handling?: 'none' | 'single-page-application' | '404-page';
  html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
  /**
   * Native Cloudflare Workers Assets routing. Managed dispatch does not route
   * by it; it reads it only to tell whether the app's worker answered a request.
   */
  run_worker_first?: boolean | Array<string>;
};

export type WebSocketRouteMeta = {
  pattern: string;
  filePath: string;
  className: string;
  bindingName?: string;
  mode: 'room' | 'socket';
  hasAuthGate: boolean;
};

export type WebSocketMigrationMeta = {
  tag: string;
  newClasses?: ReadonlyArray<string>;
  newSqliteClasses?: ReadonlyArray<string>;
  deletedClasses?: ReadonlyArray<string>;
};

export type DurableObjectMigrationStep = {
  tag?: string;
  new_classes?: ReadonlyArray<string>;
  new_sqlite_classes?: ReadonlyArray<string>;
  deleted_classes?: ReadonlyArray<string>;
  renamed_classes?: ReadonlyArray<{ from: string; to: string }>;
  transferred_classes?: ReadonlyArray<{ from: string; from_script: string; to: string }>;
};

export type PlannedWebSocketMigrations = {
  classes: ReadonlyArray<string>;
  migrations: ReadonlyArray<WebSocketMigrationMeta>;
  changed: boolean;
  nextVersion: number;
};

/**
 * Preserve an existing WebSocket class history while assigning every genuinely
 * new class to SQLite-backed Durable Object storage.
 */
export function planWebSocketMigrations(input: {
  nextClasses: ReadonlyArray<string> | undefined;
  previousClasses: ReadonlyArray<string> | undefined;
  previousMigrations: ReadonlyArray<WebSocketMigrationMeta> | undefined;
  currentVersion: number;
  tagPrefix?: string;
}): PlannedWebSocketMigrations {
  const nextClasses = sortUniqueStrings(input.nextClasses);
  const previousClasses = sortUniqueStrings(input.previousClasses);
  const previousMigrations = input.previousMigrations ?? [];
  const changed = !sameStringSet(nextClasses, previousClasses);
  if (!changed) {
    return {
      classes: nextClasses,
      migrations: previousMigrations,
      changed: false,
      nextVersion: input.currentVersion,
    };
  }

  const existingClasses = new Set(previousClasses);
  for (const migration of previousMigrations) {
    for (const name of migration.newClasses ?? []) {
      existingClasses.add(name);
    }
    for (const name of migration.newSqliteClasses ?? []) {
      existingClasses.add(name);
    }
    for (const name of migration.deletedClasses ?? []) {
      existingClasses.delete(name);
    }
  }
  const additions = nextClasses.filter((name) => !existingClasses.has(name));
  if (additions.length === 0) {
    return {
      classes: nextClasses,
      migrations: previousMigrations,
      changed: true,
      nextVersion: input.currentVersion,
    };
  }

  const nextVersion = input.currentVersion + 1;
  return {
    classes: nextClasses,
    migrations: [
      ...previousMigrations,
      {
        tag: `${input.tagPrefix ?? 'ws'}-v${nextVersion}`,
        newSqliteClasses: additions,
      },
    ],
    changed: true,
    nextVersion,
  };
}

/** Append one SQLite class step without reclassifying an existing namespace. */
export function appendSqliteClassMigration(
  migrations: ReadonlyArray<DurableObjectMigrationStep>,
  classes: ReadonlyArray<string>,
  baseTag: string,
  knownExistingClasses: ReadonlyArray<string> = [],
): { migrations: ReadonlyArray<DurableObjectMigrationStep>; added: boolean } {
  const existingClasses = new Set<string>(knownExistingClasses);
  for (const migration of migrations) {
    for (const name of migration.new_classes ?? []) {
      existingClasses.add(name);
    }
    for (const name of migration.new_sqlite_classes ?? []) {
      existingClasses.add(name);
    }
    for (const rename of migration.renamed_classes ?? []) {
      existingClasses.delete(rename.from);
      existingClasses.add(rename.to);
    }
    for (const transfer of migration.transferred_classes ?? []) {
      existingClasses.add(transfer.to);
    }
    for (const name of migration.deleted_classes ?? []) {
      existingClasses.delete(name);
    }
  }
  const additions = sortUniqueStrings(classes).filter((name) => !existingClasses.has(name));
  if (additions.length === 0) {
    return { migrations, added: false };
  }

  const tags = new Set(migrations.map((migration) => migration.tag).filter(Boolean));
  let tag = baseTag;
  for (let suffix = 2; tags.has(tag); suffix++) {
    tag = `${baseTag}-${suffix}`;
  }
  return {
    migrations: [...migrations, { tag, new_sqlite_classes: additions }],
    added: true,
  };
}

function sortUniqueStrings(values: ReadonlyArray<string> | undefined): Array<string> {
  return [...new Set(values ?? [])].sort((a, b) => a.localeCompare(b));
}

function sameStringSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type WebSocketManifestMeta = {
  routes: ReadonlyArray<WebSocketRouteMeta>;
  classes: ReadonlyArray<string>;
  migrations?: ReadonlyArray<WebSocketMigrationMeta>;
};

export type SandboxMigrationMeta = {
  tag: string;
  newSqliteClasses?: ReadonlyArray<string>;
  deletedClasses?: ReadonlyArray<string>;
};

/** Named images under the Durable Object scheduling policy must be digest-pinned. */
export function isSandboxRegistryImage(image: string): boolean {
  return /^registry\.cloudflare\.com\/[^/@\s]+\/[^@\s]+@sha256:[a-f\d]{64}$/.test(image);
}

export type SandboxManifestMeta = {
  bindingName: string;
  className: string;
  containerName: string;
  image: string;
  instanceType?: string;
  maxInstances?: number;
  migrations?: ReadonlyArray<SandboxMigrationMeta>;
  /** Written by the managed platform, never accepted from deployment clients. */
  runtime?: { protocol: 1 | 2 };
  /** Managed transport implemented by the application's bundled Void runtime. */
  controllerProtocol?: 1 | 2;
};

export type LiveMigrationMeta = {
  tag: string;
  newSqliteClasses?: ReadonlyArray<string>;
};

export type LiveManifestMeta = {
  bindingName: string;
  className: string;
  storage: 'sqlite';
  classes: ReadonlyArray<string>;
  migrations?: ReadonlyArray<LiveMigrationMeta>;
};

export type DurableObjectManifestMeta = {
  bindings: ReadonlyArray<{ bindingName: string; className: string; storage: 'sqlite' }>;
  /** Verified by the platform; never accepted from a deployment client. */
  runtime?: { protocol: 1; namespaces: Record<string, string> };
};

export type DeployManifest = {
  version: number;
  assetManifestVersion?: 1 | 2;
  /** Authenticated framed HTTP delivery for managed inbound email. */
  emailProtocolVersion?: 1;
  auth?: boolean;
  bindings: {
    d1?: Array<string>;
    kv?: Array<string>;
    r2?: Array<string>;
    ai?: boolean;
    hyperdrive?: Array<string>;
  };
  migrations?: {
    dialect: 'sqlite' | 'postgresql' | 'mysql';
    pending: number;
    protocolVersion?: 2;
    classifierVersion?: number;
    migrationListHash?: string;
    stability?: 'stable' | 'legacy';
  };
  schedules?: Array<ScheduleMeta>;
  queues?: Array<QueueMeta>;
  ssr?: boolean;
  framework?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  /** @deprecated Legacy v1 static deployment discriminator. */
  static?: 'spa' | 'ssg';
  revalidate?: number | Record<string, number>;
  revalidateQueryAllowlist?: Record<string, Array<string>>;
  pages?: Array<{ pattern: string; revalidate?: number }>;
  pathRevalidate?: Record<string, number>;
  prerender?: Array<string>;
  assetConfig?: AssetConfig;
  vars?: Record<string, string>;
  workerMain?: string;
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
  limits?: { cpuMs?: number };
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  redirectRules?: Array<RedirectRule>;
  /** Omitted values inherit the platform default; preserve explicit false. */
  alwaysUseHttps?: boolean;
  fallbackRules?: Array<RedirectRule>;
  websocket?: WebSocketManifestMeta;
  sandbox?: SandboxManifestMeta;
  live?: LiveManifestMeta;
  durableObjects?: DurableObjectManifestMeta;
};

export type DeployEvent =
  | { event: 'start'; deploymentId: string }
  | {
      event: 'heartbeat';
      deploymentId?: string;
      step: string;
      status?: 'queued' | 'running' | 'recovering';
      recoveryAt?: string;
    }
  | { event: 'asset_upload'; total: number; new: number; cached: number }
  | { event: 'asset_upload_done' }
  | { event: 'provisioning'; bindings: Array<string> }
  | { event: 'provisioning_done' }
  | { event: 'worker_readiness' }
  | { event: 'migration_start'; pending: number }
  | { event: 'migration'; name: string; durationMs: number; stability?: 'stable' | 'legacy' }
  | { event: 'migration_warning'; message: string }
  | { event: 'worker_upload'; modules: number }
  | { event: 'worker_upload_done' }
  | { event: 'queue_setup'; queues: Array<string> }
  | { event: 'queue_consumer_conflict'; queue: string; ownerScript: string }
  | { event: 'prerender'; pages: number }
  | { event: 'prerender_done' }
  | {
      event: 'done';
      deployment: string;
      url: string;
      urls: Array<string>;
      assets: number;
      workers: number;
      migrations?: number;
      published?: boolean;
    }
  | { event: 'error'; message: string; step: string };

export {
  MANIFEST_REDIRECT_RULE_STATUSES,
  MAX_REVALIDATE_QUERY_ALLOWLIST_ENTRIES,
  MAX_ROUTING_RULES,
  validateManifestShape,
} from './validate.ts';
export {
  createDeployResourcePlan,
  type DeployResource,
  type DeployResourcePlan,
} from './resource-plan.ts';
export { createDeployIntent, type DeployIntent, type DeployRuntimeFeatures } from './intent.ts';
export type {
  DeployArtifact,
  DeployAssetManifestEntry,
  DeployAssetUploadRequest,
  DeploySourceMetadata,
  DeployUploadPayload,
  DeployWorkerInput,
  DeployWorkerModule,
  DeployWorkerUploadRequest,
  DeployWorkerUploadResponse,
} from './artifact.ts';
export {
  DEPLOY_ARTIFACT_VERSION,
  createDeployArtifact,
  createDeployUploadPayload,
} from './artifact.ts';
export type {
  DeployAppType,
  DeployCapabilitySupport,
  DeployTarget,
  DeployTargetAdapter,
  DeployTargetCapabilities,
} from './target.ts';

export { canonicalJson } from './canonical-json.ts';
export { deployArtifactDigest } from './artifact-digest.ts';
export { isRecord } from './is-record.ts';
export { tokenizeSql, type SqlSegment } from './sql-tokenize.ts';
export {
  canonicalSql,
  classifySqlMigration,
  getMigrationPlanHashInput,
  hasStandalonePragma,
  isSingleStatement,
  MIGRATION_CLASSIFIER_VERSION,
  splitSqlStatements,
  UNSPLIT_MULTI_STATEMENT_PRAGMA,
  type MigrationPlanHashInput,
  type SqlMigrationClassification,
} from './migration-plan.ts';
