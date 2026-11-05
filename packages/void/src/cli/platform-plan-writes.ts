import type { PlatformInstallPlan } from './platform-plan.ts';

// Type-only imports keep this module cheap to load from the setup prompts.

export function planCreatesZone(plan: Pick<PlatformInstallPlan, 'actions'>): boolean {
  return plan.actions.some((action) => action.kind === 'zone' && action.action === 'create');
}

/**
 * Whether applying the plan writes a DNS record, which needs Zone → DNS → Edit.
 * 'reuse' changes nothing and 'adopt' only records an existing record in the
 * manifest; only 'create' calls the DNS API.
 */
export function planWritesDns(plan: Pick<PlatformInstallPlan, 'actions'>): boolean {
  return plan.actions.some(
    (action) =>
      action.kind === 'dns-record' && action.action !== 'reuse' && action.action !== 'adopt',
  );
}
