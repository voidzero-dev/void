import { existsSync, readFileSync } from 'node:fs';
import { isRecord } from '@void/deploy-core';
import { join, relative } from 'pathslash';
import { analyzeApplicationSync } from '../application-analysis.ts';
import { VOID_LOCK_FILE } from '../cloudflare-config.ts';
import { readConfig } from '../config.ts';
import { deriveDurableResourceIdentity, inferDurableResourceName } from '../durable/scan.ts';
import {
  deriveWebSocketClassNameFromName,
  inferWebSocketResourceName,
} from '../router/websocket.ts';
import { inferWorkflowResourceName } from '../workflows/scan.ts';
import type { InfoArgs } from './info-args.ts';

export type PersistentResourceInfo = {
  file: string;
  definition: 'defineDurableState' | 'defineRoom' | 'defineWebSocket' | 'defineWorkflow';
  name: string;
  nameSource: 'inferred' | 'explicit';
  className: string;
  bindingName: string;
  route?: string;
};

export type RecordedResourceInfo = {
  className: string;
  bindingName: string;
  name?: string;
  definition?: 'defineDurableState' | 'defineRoom | defineWebSocket';
};
export type ProjectInfo = {
  resources: Array<PersistentResourceInfo>;
  recordedResources: Array<RecordedResourceInfo>;
};

function readRecordedResources(
  root: string,
  resources: Array<PersistentResourceInfo>,
): Array<RecordedResourceInfo> {
  const path = join(root, VOID_LOCK_FILE);
  if (!existsSync(path)) {
    return [];
  }
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('info: Invalid void.lock.json. Fix or restore it before continuing.');
  }
  if (!isRecord(lock) || lock.version !== 1 || !isRecord(lock.resolved)) {
    throw new Error('info: Invalid void.lock.json. Fix or restore it before continuing.');
  }
  const durable = lock.resolved.durable_objects;
  const bindings = isRecord(durable) && Array.isArray(durable.bindings) ? durable.bindings : [];
  const migrations = Array.isArray(lock.resolved.migrations) ? lock.resolved.migrations : [];
  const recorded: Array<RecordedResourceInfo> = [];
  for (const binding of bindings) {
    if (
      !isRecord(binding) ||
      typeof binding.name !== 'string' ||
      typeof binding.class_name !== 'string' ||
      binding.script_name !== undefined
    ) {
      continue;
    }
    const className = binding.class_name;
    const bindingName = binding.name;
    if (
      resources.some(
        (resource) => resource.className === className && resource.bindingName === bindingName,
      )
    ) {
      continue;
    }
    const resource: RecordedResourceInfo = { className, bindingName };
    if (className.endsWith('Ws') && bindingName === className) {
      const name = className.slice(0, -2);
      if (name && deriveWebSocketClassNameFromName(name) === className) {
        resource.name = name;
        resource.definition = 'defineRoom | defineWebSocket';
      }
    } else if (className.endsWith('DurableObject')) {
      const candidates = [
        className.slice(0, -'DurableObject'.length),
        bindingName.toLowerCase().replaceAll('_', '-'),
      ];
      for (const name of candidates) {
        if (!name) {
          continue;
        }
        const identity = deriveDurableResourceIdentity(name);
        const matchesMigration = migrations.some((migration) => {
          if (!isRecord(migration) || migration.tag !== identity.migrationTag) {
            return false;
          }
          return [migration.new_classes, migration.new_sqlite_classes].some(
            (classes) => Array.isArray(classes) && classes.includes(className),
          );
        });
        if (
          identity.className === className &&
          identity.bindingName === bindingName &&
          matchesMigration
        ) {
          resource.name = name;
          resource.definition = 'defineDurableState';
          break;
        }
      }
    }
    recorded.push(resource);
  }
  return recorded.sort(
    (a, b) => a.className.localeCompare(b.className) || a.bindingName.localeCompare(b.bindingName),
  );
}

/** Inspect source without provisioning, generating files, or consulting credentials. */
export function getProjectInfo(root: string): ProjectInfo {
  const analysis = analyzeApplicationSync(root, { config: readConfig(root) });
  const resources: Array<PersistentResourceInfo> = [
    ...analysis.websockets.map((route) => ({
      file: relative(root, analysis.paths.routesDir) + '/' + route.filePath,
      definition: route.mode === 'room' ? ('defineRoom' as const) : ('defineWebSocket' as const),
      name: route.name ?? inferWebSocketResourceName(route.filePath),
      nameSource: route.name === undefined ? ('inferred' as const) : ('explicit' as const),
      className: route.className,
      bindingName: route.bindingName,
      route: route.pattern,
    })),
    ...analysis.durableObjects.map((module) => ({
      file: relative(root, module.filePath),
      definition: 'defineDurableState' as const,
      name: module.name ?? inferDurableResourceName(module.filePath),
      nameSource: module.name === undefined ? ('inferred' as const) : ('explicit' as const),
      className: module.className,
      bindingName: module.bindingName,
    })),
    ...analysis.workflows.map((module) => ({
      file: relative(root, module.filePath),
      definition: 'defineWorkflow' as const,
      name: module.name ?? inferWorkflowResourceName(module.relativePath),
      nameSource: module.name === undefined ? ('inferred' as const) : ('explicit' as const),
      className: module.className,
      bindingName: module.bindingName,
    })),
  ];
  resources.sort((a, b) => a.file.localeCompare(b.file));
  return { resources, recordedResources: readRecordedResources(root, resources) };
}

export function formatProjectInfo(info: ProjectInfo): string {
  if (info.resources.length === 0 && info.recordedResources.length === 0) {
    return 'No persistent resource definitions found in this project.';
  }
  const current = info.resources
    .map((resource) => {
      const lines = [
        resource.file,
        `  ${resource.nameSource === 'inferred' ? 'Inferred' : 'Explicit'} name: ${resource.name}`,
        `  Class: ${resource.className}`,
        `  Binding: ${resource.bindingName}`,
      ];
      if (resource.nameSource === 'inferred') {
        lines.push(
          `  To preserve this resource when moving its code, add this to '${resource.definition}':`,
          `    name: ${JSON.stringify(resource.name)},`,
        );
      } else {
        lines.push('  Keep this name when moving its code to preserve the resource.');
      }
      return lines.join('\n');
    })
    .join('\n\n');
  const recorded = info.recordedResources
    .map((resource) => {
      const lines = [
        'Recorded in void.lock.json (no matching source definition)',
        `  Class: ${resource.className}`,
        `  Binding: ${resource.bindingName}`,
      ];
      if (resource.name !== undefined) {
        lines.push(
          `  If this is the resource you moved, use this name in its ${resource.definition} definition:`,
          `    name: ${JSON.stringify(resource.name)},`,
        );
      } else {
        lines.push(
          '  Restore the original definition from source history and run void info to discover its name.',
        );
      }
      return lines.join('\n');
    })
    .join('\n\n');
  return [current, recorded].filter(Boolean).join('\n\n');
}

export async function runInfoCommand(root: string, args: InfoArgs): Promise<void> {
  const info = getProjectInfo(root);
  console.log(args.json ? JSON.stringify(info, null, 2) : formatProjectInfo(info));
}
