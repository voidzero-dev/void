import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@void/deploy-core';

/**
 * `wrangler secret put` creates a fetch-only draft before attaching a first secret to a Worker.
 * Accept that draft as first-deployment proof only when its complete deployable shape contains no
 * application code configuration or non-secret resource that an ordinary deploy could own.
 */
export function isWranglerSecretOnlyDraft(entry: Record<string, unknown>): boolean {
  if (!isRecord(entry.annotations)) {
    return false;
  }
  const annotationKeys = Object.keys(entry.annotations);
  if (
    entry.annotations['workers/triggered_by'] !== 'secret' ||
    annotationKeys.some((key) => key !== 'workers/triggered_by')
  ) {
    return false;
  }

  if (!isRecord(entry.resources)) {
    return false;
  }
  const { bindings, script, script_runtime: scriptRuntime } = entry.resources;
  if (
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    !bindings.every(
      (binding) =>
        isRecord(binding) &&
        typeof binding.name === 'string' &&
        binding.name.length > 0 &&
        binding.type === 'secret_text' &&
        Object.keys(binding).every((key) => key === 'name' || key === 'type'),
    )
  ) {
    return false;
  }

  if (
    !isRecord(script) ||
    !Array.isArray(script.handlers) ||
    script.handlers.length !== 1 ||
    script.handlers[0] !== 'fetch' ||
    script.placement_mode !== undefined
  ) {
    return false;
  }

  if (!isRecord(scriptRuntime)) {
    return false;
  }
  const runtimeKeys = Object.keys(scriptRuntime);
  return (
    scriptRuntime.usage_model === 'standard' &&
    // Cloudflare may omit unset limits instead of returning an empty object.
    (scriptRuntime.limits === undefined ||
      (isRecord(scriptRuntime.limits) && Object.keys(scriptRuntime.limits).length === 0)) &&
    runtimeKeys.every((key) => key === 'usage_model' || key === 'limits')
  );
}

// Keep these bytes aligned with the private placeholder written by Void's
// Cloudflare secret transport. Unlike the legacy Wrangler placeholder, cf
// uploads include a compatibility date, so metadata alone cannot distinguish
// them from an existing fetch-only application after a secret update.
export const VOID_SECRET_DRAFT_SOURCE =
  'export default { fetch() { return new Response(""); } };\n';

/** Message on the placeholder that Void's secret transport deploys to a Worker without code. */
export const VOID_SECRET_DRAFT_MESSAGE = 'void:secret-draft';

/**
 * Annotations of a Void secret placeholder, checked before its source is inspected:
 * - `api`: the secret transport uploaded and deployed the placeholder and its first secrets in
 *   one Workers API request.
 * - `cf_cli`: `cf workers secrets` added secrets to a deployed placeholder.
 */
export function isVoidSecretDraftHeader(entry: Record<string, unknown>): boolean {
  if (!isRecord(entry.annotations)) {
    return false;
  }
  const annotations = entry.annotations;
  const keys = Object.keys(annotations);
  if (entry.source === 'cf_cli') {
    return keys.length === 1 && annotations['workers/triggered_by'] === 'secret';
  }
  return (
    entry.source === 'api' &&
    keys.length === 2 &&
    annotations['workers/message'] === VOID_SECRET_DRAFT_MESSAGE &&
    annotations['workers/triggered_by'] === 'create_version_api'
  );
}

/** Prove a Void secret placeholder from the exact immutable version's source. */
export function isVoidSecretOnlyDraft(entry: Record<string, unknown>): boolean {
  const metadataFields = new Set([
    'id',
    'number',
    'startup_time_ms',
    'created_on',
    'source',
    'author_id',
    'author_email',
    'urls',
    'annotations',
    'compatibility_date',
    'usage_model',
    'main_module',
    'modules',
    'bindings',
    'env',
    // The cf adapter adds this compatibility view to the beta response.
    'resources',
  ]);
  if (
    Object.keys(entry).some((key) => !metadataFields.has(key)) ||
    !isVoidSecretDraftHeader(entry) ||
    entry.main_module !== 'index.js' ||
    !Array.isArray(entry.urls) ||
    entry.urls.length !== 0 ||
    !Array.isArray(entry.modules) ||
    entry.modules.length !== 1 ||
    !Array.isArray(entry.bindings) ||
    entry.bindings.length === 0
  ) {
    return false;
  }
  const module = entry.modules[0];
  if (
    !isRecord(module) ||
    Object.keys(module).length !== 3 ||
    module.name !== 'index.js' ||
    module.content_type !== 'application/javascript+module' ||
    module.content_base64 !== Buffer.from(VOID_SECRET_DRAFT_SOURCE).toString('base64')
  ) {
    return false;
  }
  const names = new Set<string>();
  for (const binding of entry.bindings) {
    if (
      !isRecord(binding) ||
      Object.keys(binding).length !== 2 ||
      typeof binding.name !== 'string' ||
      binding.name.length === 0 ||
      names.has(binding.name) ||
      binding.type !== 'secret_text'
    ) {
      return false;
    }
    names.add(binding.name);
  }
  if (
    entry.env !== undefined &&
    (!isRecord(entry.env) ||
      Object.keys(entry.env).length !== names.size ||
      Object.entries(entry.env).some(
        ([name, binding]) =>
          !names.has(name) ||
          !isRecord(binding) ||
          Object.keys(binding).length !== 1 ||
          binding.type !== 'secret_text',
      ))
  ) {
    return false;
  }
  // Never use contradictory adapter metadata as proof of an empty application.
  if (entry.resources !== undefined) {
    if (!isRecord(entry.resources) || Object.keys(entry.resources).length !== 1) {
      return false;
    }
    const bindings = entry.resources.bindings;
    if (!Array.isArray(bindings) || !isDeepStrictEqual(bindings, entry.bindings)) {
      return false;
    }
  }
  return true;
}
