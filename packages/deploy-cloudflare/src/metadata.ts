import { isRecord } from '@void/deploy-core';
import type { CloudflareCommandRunner } from './execute.ts';

/**
 * Share one authenticated transport for the activator's read-only metadata calls.
 * Writes and unsupported commands use the pinned cf command adapter. Responses
 * keep its JSON contract so activation and concurrency checks remain unchanged.
 */
export function createCloudflareMetadataRunner(options: {
  runWrangler: CloudflareCommandRunner;
  accountId: string;
  apiBaseUrl: string;
  workerName: string;
  configPath?: string;
  getToken: () => Promise<string | null>;
  verifyUploader: () => boolean;
  fetch?: typeof globalThis.fetch;
  /** Environment used to decide whether the CLI's proxy-aware transport is required. */
  env?: Readonly<Record<string, string | undefined>>;
}): CloudflareCommandRunner {
  let tokenPromise: Promise<string | null> | undefined;
  const prefix = `${options.apiBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(options.accountId)}/workers/scripts/${encodeURIComponent(options.workerName)}`;
  const fetcher = options.fetch ?? globalThis.fetch;
  const proxyEnv = options.env ?? process.env;
  const requiresProxyTransport = Boolean(
    proxyEnv.https_proxy || proxyEnv.HTTPS_PROXY || proxyEnv.http_proxy || proxyEnv.HTTP_PROXY,
  );
  const refused = {
    status: 1,
    stdout: '',
    stderr: 'Cloudflare uploader integrity check failed.',
    error: 'uploader-changed',
  };
  const fallback: CloudflareCommandRunner = (operation, runOptions) =>
    options.verifyUploader() ? options.runWrangler(operation, runOptions) : refused;
  return async (operation, runOptions) => {
    let kind: 'deployment' | 'versions' | 'version' | undefined;
    let resource: string | undefined;
    if (operation.type === 'deployments.status') {
      kind = 'deployment';
      resource = '/deployments';
    } else if (operation.type === 'versions.list') {
      kind = 'versions';
      resource = '/versions?deployable=true';
    } else if (
      operation.type === 'versions.view' &&
      !operation.includeSource &&
      /^[0-9a-f-]{36}$/i.test(operation.versionId)
    ) {
      kind = 'version';
      resource = '/versions/' + encodeURIComponent(operation.versionId);
    }
    if (
      !kind ||
      !runOptions.capture ||
      !('workerName' in operation) ||
      operation.workerName !== options.workerName ||
      operation.configPath !== options.configPath
    ) {
      return fallback(operation, runOptions);
    }
    // Node's global fetch does not reliably honor both upper- and lower-case
    // proxy variables. Keep the CLI transport in charge of proxy routing.
    if (requiresProxyTransport) {
      return fallback(operation, runOptions);
    }
    let response: Response | undefined;
    try {
      if (!tokenPromise && !options.verifyUploader()) {
        return refused;
      }
      const token = await (tokenPromise ??= options.getToken());
      if (token) {
        response = await fetcher(prefix + resource, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 401 || response.status === 403) {
          // The CLI can retry with its current session on the fallback path.
          tokenPromise = undefined;
        }
        if (response.ok) {
          const body: unknown = await response.json();
          if (isRecord(body) && body.success === true && isRecord(body.result)) {
            const result = body.result;
            if (kind === 'deployment' && Array.isArray(result.deployments)) {
              const latest: unknown = result.deployments[0];
              if (result.deployments.length === 0) {
                return {
                  status: 1,
                  stdout: '',
                  stderr: `The Worker ${options.workerName} has no deployments.`,
                  errorCode: 10_007,
                };
              }
              if (isRecord(latest) && Array.isArray(latest.versions)) {
                return { status: 0, stdout: '', data: latest, stderr: '' };
              }
            }
            if (operation.type === 'versions.view' && result.id === operation.versionId) {
              return { status: 0, stdout: '', data: result, stderr: '' };
            }
            if (kind === 'versions' && Array.isArray(result.items)) {
              const items: Array<unknown> = result.items;
              if (
                items.every(
                  (item) =>
                    isRecord(item) &&
                    isRecord(item.metadata) &&
                    typeof item.metadata.created_on === 'string',
                )
              ) {
                // Preserve the oldest-first, ten-most-recent JSON contract.
                const sorted = (items as Array<{ metadata: { created_on: string } }>)
                  .sort((a, b) => a.metadata.created_on.localeCompare(b.metadata.created_on))
                  .slice(-10);
                return { status: 0, stdout: '', data: sorted, stderr: '' };
              }
            }
          }
        }
      }
    } catch {
      // Read-only fallback retains the CLI's retry/error/auth behavior. Never
      // include token responses or provider payloads in a diagnostic here.
      tokenPromise = undefined;
    } finally {
      if (response && !response.bodyUsed) {
        await response.body?.cancel().catch(() => {});
      }
    }
    return fallback(operation, runOptions);
  };
}
