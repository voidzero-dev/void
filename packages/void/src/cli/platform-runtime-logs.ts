import type { PlatformDeploymentManifest } from '@void/platform';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';

/**
 * Namespace scripts that run project code: one `user-<slug>-<deployment>` per
 * deployment, and `void-do-<project>-<hash>` hosts for custom Durable Objects.
 */
const PROJECT_WORKER_PREFIXES = ['user-', 'void-do-'];
const CONCURRENCY = 4;

/** Printed by log readers when the platform answers `runtimeLogs: 'minimal'`. */
export const MINIMAL_RUNTIME_LOGS_NOTE =
  'Log messages, exception messages and URLs are not recorded on this platform.';

export type PlatformRuntimeLogsClient = Pick<
  PlatformCloudflareClient,
  'listDispatchNamespaceScripts' | 'patchDispatchNamespaceScriptSettings'
>;

/** Same `observability` the API sends when it uploads a project Worker. */
export function projectWorkerObservability(minimal: boolean): Record<string, unknown> {
  return minimal
    ? { enabled: false }
    : { enabled: true, logs: { invocation_logs: true, head_sampling_rate: 1 } };
}

export function assertPlatformRuntimeLogsSupported(
  deployment: PlatformDeploymentManifest,
  runtime: Readonly<{ runtimeLogs?: 1 }>,
): void {
  if (deployment.runtimeLogs && runtime.runtimeLogs !== 1) {
    throw new Error(
      'platform: This platform runtime cannot keep runtime logs minimal. Upgrade Void or use a current platform runtime.',
    );
  }
}

/**
 * Project Workers keep the settings they were uploaded with, so a changed
 * mode is pushed to them. While minimal, every operation pushes it again, so
 * a run that stopped before this step is finished by the next one.
 */
export function shouldUpdateProjectWorkerRuntimeLogs(input: {
  previous: PlatformDeploymentManifest | null | undefined;
  next: PlatformDeploymentManifest;
  explicit: boolean;
}): boolean {
  const minimal = !!input.next.runtimeLogs;
  return minimal || input.explicit || minimal !== !!input.previous?.runtimeLogs;
}

/**
 * Update every project Worker's `observability` setting. Never throws: returns
 * a warning to print when some Workers could not be updated.
 */
export async function updateProjectWorkerRuntimeLogs(
  client: PlatformRuntimeLogsClient,
  input: { accountId: string; namespace: string; minimal: boolean; installationId: string },
): Promise<string | undefined> {
  const finish = input.minimal
    ? ` Run \`void platform repair ${input.installationId}\` to finish.`
    : ` Run \`void platform upgrade ${input.installationId} --runtime-logs full\` again to finish.`;
  let scripts: ReadonlyArray<string>;
  try {
    scripts = (await client.listDispatchNamespaceScripts(input.accountId, input.namespace)).filter(
      (name) => PROJECT_WORKER_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );
  } catch (error) {
    return `Could not list project Workers to update their Workers Logs setting: ${errorMessage(error)}.${finish}`;
  }
  const settings = { observability: projectWorkerObservability(input.minimal) };
  const failed: Array<string> = [];
  let next = 0;
  const work = async () => {
    while (next < scripts.length) {
      const script = scripts[next++]!;
      try {
        await client.patchDispatchNamespaceScriptSettings(
          input.accountId,
          input.namespace,
          script,
          settings,
        );
      } catch {
        failed.push(script);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scripts.length) }, work));
  if (failed.length === 0) {
    return undefined;
  }
  failed.sort();
  const shown = failed.slice(0, 5).join(', ');
  const more = failed.length > 5 ? ` and ${failed.length - 5} more` : '';
  return `Could not update the Workers Logs setting of ${failed.length} project Worker${failed.length === 1 ? '' : 's'} (${shown}${more}).${finish}`;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.endsWith('.') ? message.slice(0, -1) : message;
}
