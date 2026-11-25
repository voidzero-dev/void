import { cloudflareWorkflowName } from './scan.ts';
import type { WorkflowModule } from './scan.ts';

export type WorkflowConfigEntry = Record<string, unknown> & {
  name?: unknown;
  binding?: unknown;
  class_name?: unknown;
  script_name?: unknown;
};

export function workflowConfigEntries(value: unknown): Array<WorkflowConfigEntry> {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
  ) {
    throw new Error('Cloudflare workflows configuration must be an array of objects.');
  }
  return value as Array<WorkflowConfigEntry>;
}

/**
 * The `workflows` entries Void adds for `workflows/` modules, given the entries
 * already configured. A module whose binding is already configured for the same
 * local class is kept as configured, so an authored entry can pin the name.
 */
export function planWorkflowAdditions(
  existing: ReadonlyArray<WorkflowConfigEntry>,
  modules: ReadonlyArray<Pick<WorkflowModule, 'bindingName' | 'className' | 'resourceName'>>,
  workerName: string,
): Array<{ name: string; binding: string; class_name: string }> {
  const additions: Array<{ name: string; binding: string; class_name: string }> = [];
  for (const module of modules) {
    const configured = existing.find((entry) => entry.binding === module.bindingName);
    if (configured) {
      if (configured.class_name !== module.className || configured.script_name !== undefined) {
        throw new Error(
          `workflows: binding '${module.bindingName}' is already configured for another Workflow, but workflows/ requires class '${module.className}'.`,
        );
      }
      continue;
    }
    const name = cloudflareWorkflowName(module.resourceName, workerName);
    const owner = [...existing, ...additions].find((entry) => entry.name === name);
    if (owner) {
      throw new Error(
        `workflows: Workflow name '${name}' is already configured for binding '${String(owner.binding)}'.`,
      );
    }
    additions.push({ name, binding: module.bindingName, class_name: module.className });
  }
  return additions;
}
