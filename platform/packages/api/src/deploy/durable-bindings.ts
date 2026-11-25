import { planWebSocketMigrations } from '@void/deploy-core';
import type { DeployManifest, LiveMigrationMeta, WebSocketMigrationMeta } from '../types.ts';
import type { PreviousDeployManifest } from './persisted-manifest.ts';
import { sortUnique } from './serving-assets.ts';

export function buildDurableObjectUploadMigrations(
  websocketMigrations: ReadonlyArray<WebSocketMigrationMeta> | undefined,
  liveMigrations?: ReadonlyArray<LiveMigrationMeta>,
):
  | {
      new_tag: string;
      steps: ReadonlyArray<{
        new_classes?: ReadonlyArray<string>;
        new_sqlite_classes?: ReadonlyArray<string>;
        deleted_classes?: ReadonlyArray<string>;
      }>;
    }
  | undefined {
  const steps: Array<{
    tag: string;
    index: number;
    new_classes?: ReadonlyArray<string>;
    new_sqlite_classes?: ReadonlyArray<string>;
    deleted_classes?: ReadonlyArray<string>;
  }> = [];

  for (const migration of websocketMigrations ?? []) {
    steps.push({
      tag: migration.tag,
      index: steps.length,
      ...(migration.newClasses?.length ? { new_classes: migration.newClasses } : {}),
      ...(migration.newSqliteClasses?.length
        ? { new_sqlite_classes: migration.newSqliteClasses }
        : {}),
      ...(migration.deletedClasses?.length ? { deleted_classes: migration.deletedClasses } : {}),
    });
  }

  for (const migration of liveMigrations ?? []) {
    steps.push({
      tag: migration.tag,
      index: steps.length,
      ...(migration.newSqliteClasses?.length
        ? { new_sqlite_classes: migration.newSqliteClasses }
        : {}),
    });
  }

  if (steps.length === 0) {
    return undefined;
  }

  const sortedSteps = [...steps].sort(compareDurableObjectMigrationSteps);

  const lastStep = sortedSteps.at(-1);
  if (!lastStep) {
    throw new Error('No Durable Object migration steps to upload.');
  }
  return {
    new_tag: lastStep.tag,
    steps: sortedSteps.map(({ tag: _tag, index: _index, ...step }) => step),
  };
}

function compareDurableObjectMigrationSteps(
  firstStep: { tag: string; index: number },
  secondStep: { tag: string; index: number },
): number {
  const firstVersion = parseMigrationTagVersion(firstStep.tag);
  const secondVersion = parseMigrationTagVersion(secondStep.tag);
  if (firstVersion !== null && secondVersion !== null && firstVersion !== secondVersion) {
    return firstVersion - secondVersion;
  }
  return firstStep.index - secondStep.index;
}

function parseMigrationTagVersion(tag: string): number | null {
  const match = /-v(\d+)$/.exec(tag);
  return match ? Number(match[1]) : null;
}

export function buildWebSocketUploadBindings(
  websocket: DeployManifest['websocket'] | undefined,
): ReadonlyArray<{
  type: 'durable_object_namespace';
  name: string;
  class_name: string;
}> {
  if (!websocket) {
    return [];
  }

  const bindings = new Map<string, string>();

  for (const route of websocket.routes) {
    const bindingName = route.bindingName ?? route.className;
    bindings.set(bindingName, route.className);
  }

  const boundClasses = new Set(bindings.values());
  for (const className of sortUnique(websocket.classes)) {
    if (!boundClasses.has(className)) {
      bindings.set(className, className);
    }
  }

  return Array.from(bindings, ([name, class_name]) => ({
    type: 'durable_object_namespace',
    name,
    class_name,
  }));
}

/**
 * Tenant code receives only the controller service. It cannot access the raw
 * container namespace, accounting control, or lifecycle callbacks.
 */
export function buildSandboxUploadBindings(
  sandbox: DeployManifest['sandbox'] | undefined,
  controllerWorkerName?: string,
): ReadonlyArray<{
  type: 'service';
  name: string;
  service: string;
}> {
  if (!sandbox) {
    return [];
  }
  if (!controllerWorkerName) {
    throw new Error('Sandbox controller Worker name is required.');
  }
  return [
    {
      type: 'service',
      name: '__VOID_SANDBOX',
      service: controllerWorkerName,
    },
  ];
}

export function buildLiveUploadBindings(live: DeployManifest['live'] | undefined): ReadonlyArray<{
  type: 'durable_object_namespace';
  name: string;
  class_name: string;
}> {
  if (!live) {
    return [];
  }
  return [
    {
      type: 'durable_object_namespace',
      name: live.bindingName,
      class_name: live.className,
    },
  ];
}

type EnrichedDurableManifest = { manifest: DeployManifest; changed: boolean; nextVersion: number };

export function enrichWebSocketManifest(
  manifest: DeployManifest,
  previousManifest: Pick<DeployManifest, 'websocket'> | null,
  currentVersion: number,
): EnrichedDurableManifest {
  const previousMigrations = previousManifest?.websocket?.migrations ?? [];
  const planned = planWebSocketMigrations({
    nextClasses: manifest.websocket?.classes,
    previousClasses: previousManifest?.websocket?.classes,
    previousMigrations,
    currentVersion,
  });

  if (!planned.changed) {
    if (!manifest.websocket && previousMigrations.length === 0) {
      return { manifest, changed: false, nextVersion: currentVersion };
    }
    return {
      manifest: {
        ...manifest,
        websocket: manifest.websocket
          ? {
              ...manifest.websocket,
              classes: planned.classes,
              migrations: planned.migrations,
            }
          : previousManifest?.websocket,
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  return {
    manifest: {
      ...manifest,
      websocket: {
        routes: manifest.websocket?.routes ?? [],
        classes: planned.classes,
        migrations: planned.migrations,
      },
    },
    changed: true,
    nextVersion: planned.nextVersion,
  };
}

export function enrichLiveManifest(
  manifest: DeployManifest,
  previousManifest: Pick<PreviousDeployManifest, 'live'> | null,
  currentVersion: number,
): EnrichedDurableManifest {
  if (!manifest.live) {
    return { manifest, changed: false, nextVersion: currentVersion };
  }

  const previousLive = previousManifest?.live;
  const previousMigrations = previousLive?.migrations ?? [];
  const nextClasses = sortUnique(manifest.live.classes);
  const nextClass = manifest.live.className;

  const existingClasses = new Set<string>();
  if (previousLive?.className) {
    existingClasses.add(previousLive.className);
  }
  for (const className of previousLive?.classes ?? []) {
    existingClasses.add(className);
  }
  for (const migration of previousMigrations) {
    for (const className of migration.newSqliteClasses ?? []) {
      existingClasses.add(className);
    }
  }

  if (existingClasses.has(nextClass)) {
    return {
      manifest: {
        ...manifest,
        live: {
          ...manifest.live,
          classes: nextClasses,
          migrations: previousMigrations,
        },
      },
      changed: false,
      nextVersion: currentVersion,
    };
  }

  const nextVersion = currentVersion + 1;
  const migration: LiveMigrationMeta = {
    tag: `live-v${nextVersion}`,
    newSqliteClasses: [nextClass],
  };

  return {
    manifest: {
      ...manifest,
      live: {
        ...manifest.live,
        classes: nextClasses,
        migrations: [...previousMigrations, migration],
      },
    },
    changed: true,
    nextVersion,
  };
}
