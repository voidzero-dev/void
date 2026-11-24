import {
  platformProjectIngressName,
  platformProjectWorkersDevHostname,
  platformWorkersDevAliasKey,
  readPlatformApplication,
  PLATFORM_PROJECT_INGRESS_SOURCE,
} from '@void/platform';
import type { PlatformApplicationProject } from '@void/platform';
import type { ApiEnv } from './env.ts';
import { cfFetch, CF_API_BASE, CloudflareApiError } from './provisioning/cloudflare-api.ts';

/** All application policy remains in the shared dispatcher, including suspension and maintenance. */
export const PROJECT_INGRESS_SOURCE = PLATFORM_PROJECT_INGRESS_SOURCE;

export async function ensureProjectIngress(
  env: ApiEnv['Bindings'],
  project: PlatformApplicationProject,
): Promise<void> {
  const application = readPlatformApplication(env);
  if (!application.workersDev) {
    return;
  }
  const { installationId } = application.workersDev;
  if (!env.DISPATCH_WORKER_NAME || installationId !== env.PLATFORM_INSTALLATION_ID) {
    throw new Error('Invalid workers.dev platform configuration.');
  }
  const name = platformProjectIngressName(project, application.workersDev);
  const hostname = platformProjectWorkersDevHostname(project, application.workersDev);
  if (application.zoneName && !(await env.ROUTING.get(platformWorkersDevAliasKey(hostname)))) {
    // After domain activation, only maintain aliases already issued during testing.
    return;
  }
  const url = `${CF_API_BASE}/${env.CF_ACCOUNT_ID}/workers/scripts/${name}`;
  const bindings = [
    { type: 'plain_text', name: 'VOID_APP_HOSTNAME', text: hostname },
    { type: 'plain_text', name: 'VOID_PROJECT_ID', text: project.id },
    { type: 'plain_text', name: 'PLATFORM_INSTALLATION_ID', text: installationId },
    { type: 'service', name: 'PLATFORM_DISPATCH', service: env.DISPATCH_WORKER_NAME },
  ];
  let exists = false;
  try {
    const settings = await cfFetch<{ bindings: Array<Record<string, unknown>> }>(
      `${url}/settings`,
      env.CF_API_TOKEN,
    );
    exists = true;
    if (
      !bindings.every((binding) =>
        settings.bindings.some((current) =>
          Object.entries(binding).every(([key, value]) => current[key] === value),
        ),
      )
    ) {
      throw new Error(
        `Refusing to replace workers.dev ingress ${name}: ownership or bindings differ.`,
      );
    }
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 404)) {
      throw error;
    }
  }
  if (!exists) {
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({ main_module: 'index.js', compatibility_date: '2026-02-24', bindings }),
    );
    form.append(
      'index.js',
      new Blob([PROJECT_INGRESS_SOURCE], { type: 'application/javascript+module' }),
      'index.js',
    );
    const response = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'If-None-Match': '*' },
      body: form,
    });
    const body = await response.json<{ success?: boolean }>();
    if (!response.ok || body.success !== true) {
      throw new Error(`Could not provision workers.dev ingress ${name} (HTTP ${response.status}).`);
    }
  }
  await env.ROUTING.put(platformWorkersDevAliasKey(hostname), JSON.stringify(project));
  await cfFetch(`${url}/subdomain`, env.CF_API_TOKEN, {
    method: 'POST',
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
}
