import { fileURLToPath } from 'node:url';
import { isSandboxRegistryImage } from '@void/deploy-core';
import type { DurableObjectMigrationStep } from '@void/deploy-core';
import { isAbsolute, join } from 'pathslash';
import type { VoidConfig } from '../config.ts';

export const DEFAULT_SANDBOX_BINDING = 'SANDBOX';
export const DEFAULT_SANDBOX_CLASS_NAME = 'SandboxV1';
const DEFAULT_SANDBOX_CONTAINER_NAME = 'void-sandbox-v1';
export const SANDBOX_MIGRATION_TAG = 'void-sandbox-v2';

export type SandboxInstanceType =
  | 'lite'
  | 'basic'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4';

export type SandboxConfig = {
  binding?: string;
  className?: string;
  containerName?: string;
  image?: string;
  imageBuildContext?: string;
  platformImage?: string;
  instanceType?: SandboxInstanceType;
};

export type ResolvedSandboxConfig = {
  binding: string;
  className: string;
  containerName: string;
  image: string;
  imageBuildContext?: string;
  platformImage: string;
  instanceType?: SandboxInstanceType;
};

export function isSandboxEnabled(config: VoidConfig): boolean {
  return config.sandbox !== undefined && config.sandbox !== false;
}

function getDefaultSandboxImage(): string {
  return fileURLToPath(new URL('../../sandbox.Dockerfile', import.meta.resolve('void/sandbox')));
}

function getDefaultSandboxPlatformImage(): string {
  return 'cloudflare/debian-trixie';
}

function isLocalSandboxImage(image: string): boolean {
  return (
    isAbsolute(image) ||
    image.startsWith('./') ||
    image.startsWith('../') ||
    image.toLowerCase().includes('dockerfile')
  );
}

export function requiresSandboxPlatformImage(config: VoidConfig): boolean {
  if (typeof config.sandbox !== 'object' || config.sandbox === null) {
    return false;
  }
  return (
    typeof config.sandbox.image === 'string' &&
    isLocalSandboxImage(config.sandbox.image) &&
    config.sandbox.platformImage === undefined
  );
}

export function resolveSandboxConfig(
  config: VoidConfig,
  root: string = process.cwd(),
): ResolvedSandboxConfig {
  const raw = typeof config.sandbox === 'object' ? config.sandbox : {};
  const image = raw.image ?? getDefaultSandboxImage();
  const imageBuildContext = raw.imageBuildContext;
  const platformImage =
    raw.platformImage ??
    (raw.image && !isLocalSandboxImage(raw.image) ? raw.image : getDefaultSandboxPlatformImage());

  if (!isLocalSandboxImage(image) && !isSandboxRegistryImage(image)) {
    throw new Error(
      'sandbox.image must be a Dockerfile or a digest-pinned Cloudflare registry image (registry.cloudflare.com/<account>/<image>@sha256:<digest>).',
    );
  }
  if (
    platformImage !== getDefaultSandboxPlatformImage() &&
    !isSandboxRegistryImage(platformImage)
  ) {
    throw new Error(
      'sandbox.platformImage must be a digest-pinned Cloudflare registry image (registry.cloudflare.com/<account>/<image>@sha256:<digest>).',
    );
  }

  return {
    binding: raw.binding ?? DEFAULT_SANDBOX_BINDING,
    className: raw.className ?? DEFAULT_SANDBOX_CLASS_NAME,
    containerName: raw.containerName ?? DEFAULT_SANDBOX_CONTAINER_NAME,
    image: resolveSandboxImage(image, root),
    platformImage,
    ...(imageBuildContext && {
      imageBuildContext: isAbsolute(imageBuildContext)
        ? imageBuildContext
        : join(root, imageBuildContext),
    }),
    ...(raw.instanceType && { instanceType: raw.instanceType }),
  };
}

function resolveSandboxImage(image: string, root: string): string {
  if (!isLocalSandboxImage(image) || isAbsolute(image)) {
    return image;
  }
  return join(root, image);
}

type SandboxContainerConfig = {
  name: string;
  class_name: string;
  scheduling_policy: 'durable_object';
  images: { default: { dockerfile: string; build_context?: string } | { image: string } };
};

export function sandboxContainerConfig(sandbox: ResolvedSandboxConfig): SandboxContainerConfig {
  return {
    name: sandbox.containerName,
    class_name: sandbox.className,
    scheduling_policy: 'durable_object',
    images: {
      default: isLocalSandboxImage(sandbox.image)
        ? {
            dockerfile: sandbox.image,
            ...(sandbox.imageBuildContext && { build_context: sandbox.imageBuildContext }),
          }
        : { image: sandbox.image },
    },
  };
}

/** Resolve the final local storage kind without recreating a renamed or deleted class. */
function resolveSandboxMigrationStorage(
  migrations: ReadonlyArray<DurableObjectMigrationStep>,
  className: string,
): 'sqlite' | 'legacy-kv' | 'unknown' | undefined {
  const storage = new Map<string, 'sqlite' | 'legacy-kv' | 'unknown'>();
  for (const migration of migrations) {
    for (const name of migration.new_classes ?? []) {
      storage.set(name, 'legacy-kv');
    }
    for (const name of migration.new_sqlite_classes ?? []) {
      storage.set(name, 'sqlite');
    }
    for (const rename of migration.renamed_classes ?? []) {
      const sqlite = storage.get(rename.from);
      storage.delete(rename.from);
      storage.set(rename.to, sqlite ?? 'unknown');
    }
    // A transferred class's source storage is not established by this local history.
    for (const transfer of migration.transferred_classes ?? []) {
      storage.set(transfer.to, 'unknown');
    }
    for (const name of migration.deleted_classes ?? []) {
      storage.delete(name);
    }
  }
  return storage.get(className);
}

export function hasSandboxSqliteMigration(
  migrations: ReadonlyArray<DurableObjectMigrationStep>,
  className: string,
): boolean {
  return resolveSandboxMigrationStorage(migrations, className) === 'sqlite';
}

/** Refuse namespace reuse before either uploader can change a live Worker. */
export function assertSandboxNamespaceConfig(
  config: Record<string, unknown>,
  sandbox: ResolvedSandboxConfig,
): void {
  const containers = Array.isArray(config.containers)
    ? (config.containers as Array<{ class_name?: unknown; scheduling_policy?: unknown }>)
    : [];
  const durable = config.durable_objects as
    | {
        bindings?: Array<{
          name: string;
          class_name: string;
          script_name?: string;
          environment?: string;
        }>;
      }
    | undefined;
  const binding = durable?.bindings?.find((entry) => entry.name === sandbox.binding);
  if (binding && (binding.script_name !== undefined || binding.environment !== undefined)) {
    throw new Error(
      `sandbox: binding '${sandbox.binding}' must reference the local '${sandbox.className}' class. Choose another sandbox.binding name to preserve the existing external Durable Object.`,
    );
  }
  const migrations = Array.isArray(config.migrations)
    ? (config.migrations as Array<DurableObjectMigrationStep>)
    : [];
  const storage = resolveSandboxMigrationStorage(migrations, sandbox.className);
  if (storage === 'legacy-kv' || storage === 'unknown') {
    throw new Error(
      `sandbox: class '${sandbox.className}' needs SQLite storage, but its existing namespace has ${storage} storage. Preserve the existing migration history and choose a fresh Worker name or a new sandbox.className and sandbox.binding.`,
    );
  }
  if (
    storage !== 'sqlite' &&
    migrations.some((migration) => migration.tag === SANDBOX_MIGRATION_TAG)
  ) {
    throw new Error(
      `sandbox: migration tag '${SANDBOX_MIGRATION_TAG}' is already configured for another class. Keep the existing history and choose a fresh Worker for Sandbox.`,
    );
  }
  if (
    containers.some(
      (container) =>
        container.class_name === sandbox.className &&
        container.scheduling_policy !== 'durable_object',
    ) ||
    durable?.bindings?.some(
      (binding) => binding.name === sandbox.binding && binding.class_name !== sandbox.className,
    )
  ) {
    throw new Error(
      'Sandbox SDK 1.0 needs a new Durable Object namespace. Back up existing Sandbox data and deploy to a fresh Worker name with the new Sandbox configuration; remove legacy Sandbox bindings, containers, and migrations from that new Worker configuration. See https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/.',
    );
  }
}
