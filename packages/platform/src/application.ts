import { createPlatformDeploymentManifest, readPlatformApplicationInput } from './manifest.ts';

/** Public application addressing, independent of the platform API's origin. */
export type PlatformApplication = Readonly<{
  baseDomain: string;
  dedicatedZone: boolean;
  /** Empty only for an explicitly selected workers.dev installation. */
  zoneName: string;
  zoneId?: string;
  /** Retained after adding a domain so existing test URLs keep working. */
  workersDev?: Readonly<{ subdomain: string; installationId: string }>;
}>;

export type PlatformApplicationProject = Readonly<{ id: string; slug: string }>;

/** Minimal public-origin adapter; request policy remains in the service-bound dispatcher. */
export const PLATFORM_PROJECT_INGRESS_SOURCE: string = `export default {
  fetch(request, env) {
    if (new URL(request.url).hostname !== env.VOID_APP_HOSTNAME) {
      return new Response('Not Found', {status: 404});
    }
    return env.PLATFORM_DISPATCH.fetch(request);
  }
};`;

export function readPlatformApplication(
  env: Readonly<{ PLATFORM_APPLICATION?: string; SITE_DOMAIN?: string; BASE_HOSTNAME?: string }>,
): PlatformApplication {
  const baseDomain = env.SITE_DOMAIN ?? env.BASE_HOSTNAME ?? 'void.app';
  if (!env.PLATFORM_APPLICATION) {
    return { baseDomain, zoneName: baseDomain, dedicatedZone: false };
  }
  return parsePlatformApplication(JSON.parse(env.PLATFORM_APPLICATION));
}

/** Applies the deployment manifest's application rules to a parsed value. */
export function parsePlatformApplication(value: unknown): PlatformApplication {
  return createPlatformDeploymentManifest({
    installationSlug: 'runtime',
    displayName: 'Runtime',
    application: readPlatformApplicationInput(value),
  }).application;
}

export function platformWorkersDevAliasKey(hostname: string): string {
  return `workers-dev:${hostname}`;
}

export const PLATFORM_APPLICATION_KEY = '__void/platform/application/v1';

export async function resolvePlatformApplicationEnvironment<
  T extends {
    PLATFORM_APPLICATION?: string;
    ROUTING: { get(key: string): Promise<string | null> };
  },
>(env: T): Promise<T> {
  if (!env.PLATFORM_APPLICATION) {
    return env;
  }
  const raw = await env.ROUTING.get(PLATFORM_APPLICATION_KEY);
  if (!raw) {
    return env;
  }
  const previous = readPlatformApplication(env);
  const next = readPlatformApplication({ PLATFORM_APPLICATION: raw });
  if (
    !previous.workersDev ||
    !next.workersDev ||
    previous.workersDev.installationId !== next.workersDev.installationId ||
    previous.workersDev.subdomain !== next.workersDev.subdomain
  ) {
    throw new Error('Application routing belongs to another platform installation.');
  }
  return {
    ...env,
    PLATFORM_APPLICATION: raw,
    SITE_DOMAIN: next.baseDomain,
    BASE_HOSTNAME: next.baseDomain,
    ...(next.zoneId ? { CF_ZONE_ID: next.zoneId } : {}),
  };
}

export function platformProjectIngressPrefix(
  workersDev: NonNullable<PlatformApplication['workersDev']>,
): string {
  return `void-${workersDev.installationId.slice(-12)}-`;
}

export function platformProjectIngressName(
  project: PlatformApplicationProject,
  workersDev: NonNullable<PlatformApplication['workersDev']>,
): string {
  if (!/^proj_[a-z0-9]{1,32}$/.test(project.id) || !/^[a-z0-9][a-z0-9-]*$/.test(project.slug)) {
    throw new Error('Invalid platform project identity.');
  }
  const prefix = platformProjectIngressPrefix(workersDev);
  const suffix = `-${project.id.slice(5)}`;
  const slug = project.slug.slice(0, 63 - prefix.length - suffix.length).replace(/-+$/, '');
  return `${prefix}${slug}${suffix}`;
}

export function platformProjectWorkersDevHostname(
  project: PlatformApplicationProject,
  workersDev: NonNullable<PlatformApplication['workersDev']>,
): string {
  return `${platformProjectIngressName(project, workersDev)}.${workersDev.subdomain}.workers.dev`;
}

/**
 * Project slug the platform keeps for its own health probe. Project Zero Trust
 * leaves only `/health` on this hostname outside Cloudflare Access so the
 * authenticated probe reaches dispatch, which never routes that path to a
 * project. New projects cannot claim the slug; a project that already owns it
 * keeps every other path, behind Access like any other project hostname.
 */
export const PLATFORM_HEALTH_HOSTNAME_LABEL = 'void-platform-health';

/** The application-domain hostname for dispatch health probes; null without a zone. */
export function platformHealthHostname(application: PlatformApplication): string | null {
  return application.zoneName
    ? `${PLATFORM_HEALTH_HOSTNAME_LABEL}.${application.baseDomain}`
    : null;
}

export function platformProjectHostname(
  project: PlatformApplicationProject,
  application: PlatformApplication,
): string {
  if (!application.zoneName && application.workersDev) {
    return platformProjectWorkersDevHostname(project, application.workersDev);
  }
  return `${project.slug}.${application.baseDomain}`;
}

export function platformProjectHostnames(
  project: PlatformApplicationProject,
  application: PlatformApplication,
): ReadonlyArray<string> {
  return [
    ...new Set([
      platformProjectHostname(project, application),
      ...(application.workersDev
        ? [platformProjectWorkersDevHostname(project, application.workersDev)]
        : []),
    ]),
  ];
}
