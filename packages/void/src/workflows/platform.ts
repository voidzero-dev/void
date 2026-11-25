import { scanWorkflowModules } from './scan.ts';

/** Void platform deploys do not provision Cloudflare Workflows yet. */
export function assertNoWorkflowsForPlatform(root: string): void {
  if (scanWorkflowModules(root).length > 0) {
    throw new Error(
      'workflows: workflows/ is not supported on Void platforms yet. Deploy this app to your own Cloudflare account with `void deploy --platform cloudflare`.',
    );
  }
}
