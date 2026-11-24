import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';

/** Custom images need a prepared snapshot before a native container can start. */
export async function prepareContainerImage(
  accountId: string,
  apiToken: string,
  image: string,
): Promise<void> {
  if (image === 'cloudflare/debian-trixie') {
    return;
  }
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('Cloudflare Container image preparation timed out. Retry the deployment.');
    }
    const result = await cfFetch<{ image: string; status: string }>(
      `${CF_API_BASE}/${accountId}/containers/image-preparations`,
      apiToken,
      {
        method: 'POST',
        body: JSON.stringify({ image }),
        signal: AbortSignal.timeout(remaining),
      },
    );
    if (result.image !== image) {
      throw new Error('Cloudflare Container image preparation returned another image.');
    }
    if (result.status === 'ready') {
      return;
    }
    if (result.status !== 'pending') {
      throw new Error('Cloudflare Container image preparation failed. Retry the deployment.');
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, remaining)));
  }
}

export type ContainerApplicationInfo = Readonly<{
  id: string;
  name: string;
  scheduling_policy?: string;
  configuration?: {
    image?: string;
    instance_type?: string;
  };
  durable_objects?: {
    namespace_id?: string;
  };
  max_instances?: number;
}>;

type ScriptBinding = Readonly<{
  type: string;
  name?: string;
  class_name?: string;
  namespace_id?: string;
}>;

/**
 * Resolve a Durable Object namespace ID for a class on a WfP script.
 *
 * Reads the script's own bindings (per-script endpoint) instead of paging the
 * account-wide `/workers/durable_objects/namespaces` listing. The listing
 * endpoint is global, doesn't accept a working `script` filter (CF ignores it
 * silently), and races against propagation lag for new WfP scripts. The
 * per-script bindings endpoint returns `namespace_id` directly the moment the
 * script is uploaded, so the caller's retry loop only ever waits for the
 * worker upload step itself to be visible — not for the global list to
 * eventually-consist.
 */
export async function findDurableObjectNamespaceId(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
  bindingName: string,
  className: string,
): Promise<string> {
  const bindings = await cfFetch<ReadonlyArray<ScriptBinding>>(
    `${CF_API_BASE}/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}/bindings`,
    apiToken,
  );

  const match = bindings.find(
    (binding) =>
      binding.type === 'durable_object_namespace' &&
      binding.name === bindingName &&
      binding.class_name === className &&
      typeof binding.namespace_id === 'string',
  );

  if (!match || !match.namespace_id) {
    throw new Error(
      `Durable Object namespace binding not found on ${dispatchNamespace}/${scriptName} for ${bindingName}=${className}`,
    );
  }

  return match.namespace_id;
}

export async function deleteContainerApplication(
  accountId: string,
  apiToken: string,
  applicationId: string,
): Promise<void> {
  await cfFetch(`${containersUrl(accountId)}/applications/${applicationId}`, apiToken, {
    method: 'DELETE',
  });
}

/**
 * Idempotent variant of {@link deleteContainerApplication}. Swallows 404
 * responses (the application is already gone) and re-throws any other error.
 * Used by the deploy pipeline and project teardown to make repeated DELETE
 * attempts safe under partial-failure replay.
 */
export async function deleteContainerApplicationIdempotent(
  accountId: string,
  apiToken: string,
  applicationId: string,
): Promise<void> {
  try {
    await deleteContainerApplication(accountId, apiToken, applicationId);
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) {
      return;
    }
    throw err;
  }
}

export async function getContainerApplication(
  accountId: string,
  apiToken: string,
  applicationId: string,
): Promise<ContainerApplicationInfo | undefined> {
  try {
    return await cfFetch<ContainerApplicationInfo>(
      `${containersUrl(accountId)}/applications/${applicationId}`,
      apiToken,
    );
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

/**
 * POST a new container application. Returns the created app on success, or
 * `undefined` if CF reports the app already exists (i.e. a concurrent deploy
 * won the race) so the caller can fall back to PATCH. Any other error
 * propagates.
 *
 * Status 409 is the authoritative race signal; message matching is a
 * defense-in-depth fallback for non-conventional responses where CF returns a
 * different status but the body still says "already exists".
 */
export async function tryCreateContainerApplication(
  accountId: string,
  apiToken: string,
  config: Readonly<{ name: string; namespaceId: string }>,
): Promise<ContainerApplicationInfo | undefined> {
  try {
    return await cfFetch<ContainerApplicationInfo>(
      `${containersUrl(accountId)}/applications`,
      apiToken,
      {
        method: 'POST',
        body: JSON.stringify({
          name: config.name,
          scheduling_policy: 'durable_object',
          durable_objects: { namespace_id: config.namespaceId },
        }),
      },
    );
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 409) {
      return undefined;
    }
    if (err instanceof Error && isAlreadyExistsError(err.message)) {
      return undefined;
    }
    throw err;
  }
}

// Intentionally does not match the bare word 'conflict' — it appears in unrelated CF validation errors (e.g. "configuration conflicts with durable object namespace") and would cause a false-positive race fallback.
function isAlreadyExistsError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('already exists') || lower.includes('duplicate');
}

export async function findContainerApplication(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<ContainerApplicationInfo | undefined> {
  const applications = await cfFetch<ReadonlyArray<ContainerApplicationInfo>>(
    `${containersUrl(accountId)}/applications?name=${encodeURIComponent(name)}`,
    apiToken,
  );
  return applications.find((application) => application.name === name);
}

function containersUrl(accountId: string): string {
  return `${CF_API_BASE}/${accountId}/containers`;
}

/**
 * Compute the per-deploy CF container application name. The deployment id is
 * baked in so each deploy gets a globally-unique name — the per-deploy
 * architecture relies on every POST creating a fresh app (one DO namespace
 * can only ever bind to one container app, and each deploy mints a fresh
 * namespace via its own `Sandbox` class declaration).
 *
 * Lowercased and underscores converted to dashes because CF container names
 * reject uppercase / `_`.
 */
export function perDeployContainerApplicationName(
  projectId: string,
  deploymentId: string,
  containerName: string,
): string {
  return `${projectId}-${deploymentId}-${containerName}`.toLowerCase().replaceAll('_', '-');
}
