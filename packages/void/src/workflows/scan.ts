import { existsSync, readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { globSync } from 'tinyglobby';
import { readResourceDefinition } from '../shared/resource-definition.ts';
import { resourceNameWords } from '../shared/resource-name.ts';

export type WorkflowModule = {
  filePath: string;
  /** Path relative to `workflows/`, with `/` separators. */
  relativePath: string;
  bindingName: string;
  className: string;
  /** Kebab-case resource name. Cloudflare Workflow names are derived from it. */
  resourceName: string;
  name?: string;
};

const MODULE_PATTERN = /\.(?:[cm]?[jt]s)$/;
const MODULE_GLOB = '**/*.{ts,mts,cts,js,mjs,cjs}';

const WORKFLOW_HELPERS = new Set(['defineWorkflow', 'defineWorkflowEntrypoint']);

/**
 * The name a module gets without an explicit `name`: its path relative to
 * `workflows/` without the extension, with directories joined by `-`, as
 * queue names are (`order/notifications.ts` → `order-notifications`).
 */
export function inferWorkflowResourceName(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(MODULE_PATTERN, '').replaceAll('/', '-');
}

/** Module files under `workflows/`, skipping declarations and `_`-prefixed files or directories. */
function listWorkflowFiles(directory: string): Array<string> {
  return globSync(MODULE_GLOB, { cwd: directory })
    .map((file) => file.replaceAll('\\', '/'))
    .filter(
      (file) =>
        !file.endsWith('.d.ts') &&
        !file.endsWith('.d.mts') &&
        !file.endsWith('.d.cts') &&
        file.split('/').every((segment) => !segment.startsWith('_')),
    )
    .sort((a, b) => a.localeCompare(b));
}

export function deriveWorkflowResourceIdentity(name: string): {
  bindingName: string;
  className: string;
  resourceName: string;
} {
  const parts = resourceNameWords(name);
  const classBase = parts.map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  return {
    bindingName: `WORKFLOW_${parts.join('_').toUpperCase()}`,
    className: `${classBase}Workflow`,
    resourceName: parts.join('-').toLowerCase(),
  };
}

/**
 * Cloudflare Workflow names are unique per account. Deploys prefix them with the
 * Worker name; local development, where names only need to be unique per Worker,
 * uses the resource name alone.
 */
export function cloudflareWorkflowName(resourceName: string, workerName?: string): string {
  if (!workerName) {
    return resourceName;
  }
  const prefix = workerName.toLowerCase().replaceAll('_', '-');
  return `${prefix}-${resourceName}`.slice(0, 64);
}

export function scanWorkflowModules(root: string): Array<WorkflowModule> {
  const directory = join(root, 'workflows');
  if (!existsSync(directory)) {
    return [];
  }

  const modules = listWorkflowFiles(directory).map((relativePath) => {
    const filePath = join(directory, relativePath);
    const definition = readResourceDefinition(
      filePath,
      readFileSync(filePath, 'utf8'),
      WORKFLOW_HELPERS,
    );
    const name = definition?.name;
    const resourceName = name ?? inferWorkflowResourceName(relativePath);
    if (resourceNameWords(resourceName).length === 0) {
      throw new Error(`workflows: cannot derive a name from workflows/${relativePath}.`);
    }
    return {
      filePath,
      relativePath,
      ...deriveWorkflowResourceIdentity(resourceName),
      ...(name === undefined ? {} : { name }),
    };
  });

  const bindings = new Set<string>();
  const classes = new Set<string>();
  for (const module of modules) {
    if (bindings.has(module.bindingName) || classes.has(module.className)) {
      throw new Error(
        `workflows: duplicate generated name for 'workflows/${module.relativePath}'. Choose a different resource name or rename one of the workflows files.`,
      );
    }
    bindings.add(module.bindingName);
    classes.add(module.className);
  }
  return modules;
}
