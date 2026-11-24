import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { readResourceDefinition } from '../shared/resource-definition.ts';
import { resourceNameWords } from '../shared/resource-name.ts';

export type DurableObjectModule = {
  filePath: string;
  bindingName: string;
  className: string;
  migrationTag: string;
  name?: string;
};

const MODULE_PATTERN = /\.(?:[cm]?[jt]s)$/;

export function inferDurableResourceName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop()!.replace(MODULE_PATTERN, '');
}

const DURABLE_HELPERS = new Set(['defineDurableState', 'defineDurableObject']);

export function deriveDurableResourceIdentity(name: string): {
  bindingName: string;
  className: string;
  migrationTag: string;
} {
  const parts = resourceNameWords(name);
  const classBase = parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join('');
  return {
    bindingName: parts.join('_').toUpperCase(),
    className: `${classBase}DurableObject`,
    migrationTag: `void-durable-${parts.join('-').toLowerCase()}-v1`,
  };
}

export function scanDurableObjectModules(root: string): Array<DurableObjectModule> {
  const directory = join(root, 'durable-objects');
  if (!existsSync(directory)) {
    return [];
  }

  const modules = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && MODULE_PATTERN.test(entry.name) && !entry.name.endsWith('.d.ts'),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const filePath = join(directory, entry.name);
      const definition = readResourceDefinition(
        filePath,
        readFileSync(filePath, 'utf8'),
        DURABLE_HELPERS,
      );
      const name = definition?.name;
      const resourceName = name ?? inferDurableResourceName(entry.name);
      if (resourceNameWords(resourceName).length === 0) {
        throw new Error(`durable: cannot derive a name from durable-objects/${entry.name}.`);
      }
      return {
        filePath,
        ...deriveDurableResourceIdentity(resourceName),
        ...(name === undefined ? {} : { name }),
      };
    });

  const bindings = new Set<string>();
  const classes = new Set<string>();
  for (const module of modules) {
    if (bindings.has(module.bindingName) || classes.has(module.className)) {
      throw new Error(
        `durable: duplicate generated name for '${module.filePath}'. Choose a different resource name or rename one of the durable-objects files.`,
      );
    }
    bindings.add(module.bindingName);
    classes.add(module.className);
  }
  return modules;
}
