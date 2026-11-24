import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  type CloudflareCommandResult,
  type CloudflareOperation,
  type CloudflareCommandRunner,
} from '@void/deploy-cloudflare';
import {
  type ConditionalWorkerCreateProxy,
  type ConditionalWorkerCreateState,
} from './platform-installer-types.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';
import { createDefaultRunWrangler, resolvePinnedApiBaseUrl } from './provision.ts';

export function platformWorkerCommandRunner(
  accountId: string,
  cwd: string,
  runner: typeof runPlatformWrangler,
): CloudflareCommandRunner {
  return (operation, options) => runner(operation, accountId, cwd, options.capture);
}

export async function runPlatformWrangler(
  operation: CloudflareOperation,
  accountId: string,
  cwd: string,
  capture: boolean,
): Promise<CloudflareCommandResult> {
  return runPlatformWranglerAtApiBase(operation, accountId, cwd, capture);
}

const PLATFORM_WRANGLER_TIMEOUT_MS = 10 * 60 * 1000;

/** Opt-in maintainer diagnostics, enabled with VOID_PLATFORM_TIMINGS=1. */
export function writePlatformTiming(label: string, startedAt: number): void {
  if (process.env.VOID_PLATFORM_TIMINGS === '1') {
    process.stderr.write(
      `[platform timing] ${label} ${(performance.now() - startedAt).toFixed(0)} ms\n`,
    );
  }
}

export async function runPlatformWranglerAtApiBase(
  operation: CloudflareOperation,
  accountId: string,
  cwd: string,
  capture: boolean,
  apiBaseUrl: string = resolvePinnedApiBaseUrl(),
  parallelWorkerUpload = false,
  apiToken?: string,
): Promise<CloudflareCommandResult> {
  const startedAt = performance.now();
  const runner = createDefaultRunWrangler(process.cwd(), {
    launcher: resolveCloudflareOperationArgv(),
    parallelWorkerUpload,
    timeoutMs: PLATFORM_WRANGLER_TIMEOUT_MS,
  });
  const result = await runner(operation, {
    accountId,
    apiBaseUrl,
    apiToken,
    cwd,
  });
  writePlatformTiming(`Cloudflare ${operation.type}`, startedAt);
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  // Void owns progress output. Successful commands may still emit banners and
  // warnings; keep those captured, but retain diagnostics for failed commands.
  if (!capture && result.status !== 0) {
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
  }
  return { ...result, stderr, stdout };
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
    server.closeAllConnections();
  });
}

async function startConditionalWorkerCreateProxy(
  upstreamApiBaseUrl: string,
  accountId: string,
  workerName: string,
): Promise<ConditionalWorkerCreateProxy> {
  const upstreamBase = new URL(upstreamApiBaseUrl);
  if (upstreamBase.protocol !== 'http:' && upstreamBase.protocol !== 'https:') {
    throw new Error('platform: Cloudflare API base URL must use HTTP or HTTPS.');
  }
  const basePath = upstreamBase.pathname.replace(/\/+$/, '');
  const accountPath = `${basePath}/accounts/${encodeURIComponent(accountId)}`;
  const expectedPath = `${accountPath}/workers/scripts/${encodeURIComponent(workerName)}`;
  const assetUploadPath = `${accountPath}/workers/assets/upload`;
  const state: ConditionalWorkerCreateState = {
    assetSessionStarted: false,
    attempted: false,
    conflictStatus: null,
    created: false,
    forwarded: false,
    rejectedMutation: null,
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const incomingUrl = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      if (incomingUrl.pathname !== basePath && !incomingUrl.pathname.startsWith(`${basePath}/`)) {
        outgoing.writeHead(502, { 'Content-Type': 'application/json' });
        outgoing.end('{"success":false,"errors":[{"message":"Invalid API proxy path"}]}');
        return;
      }
      // Wrangler omits script content from the response and requests strict
      // binding inheritance. These are the only accepted create-query options.
      const createQuery = [...incomingUrl.searchParams];
      const supportedCreateQuery =
        new Set(createQuery.map(([key]) => key)).size === createQuery.length &&
        createQuery.every(
          ([key, value]) =>
            (key === 'excludeScript' && value === 'true') ||
            (key === 'bindings_inherit' && value === 'strict'),
        );
      const isConditionalCreate =
        incoming.method === 'PUT' && incomingUrl.pathname === expectedPath && supportedCreateQuery;
      const isTopLevelWorkerUpload =
        incoming.method === 'PUT' &&
        new RegExp(
          `^${basePath.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}/accounts/[^/]+/workers/scripts/[^/]+$`,
        ).test(incomingUrl.pathname);
      const isReadOnly =
        incoming.method === 'GET' || incoming.method === 'HEAD' || incoming.method === 'OPTIONS';
      // A Worker with static assets must register its asset manifest and upload
      // the missing files before the script PUT that references them. Neither
      // step attaches anything to a Worker; only the guarded create does.
      const isAssetUploadSession =
        incoming.method === 'POST' &&
        incomingUrl.pathname === `${expectedPath}/assets-upload-session` &&
        incomingUrl.search === '';
      const isAssetUpload =
        incoming.method === 'POST' &&
        state.assetSessionStarted &&
        ((incomingUrl.pathname === assetUploadPath && incomingUrl.search === '?base64=true') ||
          (incomingUrl.search === '' &&
            incomingUrl.pathname.startsWith(`${assetUploadPath}/`) &&
            /^[0-9a-f]{32}$/.test(incomingUrl.pathname.slice(assetUploadPath.length + 1))));
      if (
        (isTopLevelWorkerUpload && !isConditionalCreate) ||
        (!isReadOnly &&
          !isConditionalCreate &&
          !isAssetUploadSession &&
          !isAssetUpload &&
          !state.created)
      ) {
        state.rejectedMutation = `${incoming.method ?? 'UNKNOWN'} ${incomingUrl.pathname}${
          incomingUrl.pathname === expectedPath && !supportedCreateQuery
            ? ' (unsupported Worker create query)'
            : ''
        }`;
        incoming.resume();
        outgoing.writeHead(409, { 'Content-Type': 'application/json' });
        outgoing.end(
          '{"success":false,"errors":[{"message":"Mutation blocked until conditional Worker creation succeeds"}]}',
        );
        return;
      }
      const headers = forwardHeaders(incoming.headers);
      delete headers.host;
      if (isConditionalCreate) {
        state.attempted = true;
        headers['if-none-match'] = '*';
      }
      if (isAssetUploadSession) {
        state.assetSessionStarted = true;
      }
      const upstreamUrl = new URL(
        `${incomingUrl.pathname}${incomingUrl.search}`,
        upstreamBase.origin,
      );
      const request = (upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest)(
        upstreamUrl,
        {
          headers,
          method: incoming.method,
        },
        (response) => {
          if (isConditionalCreate) {
            state.forwarded = true;
            if (response.statusCode === 409 || response.statusCode === 412) {
              state.conflictStatus = response.statusCode;
            }
            state.created =
              response.statusCode !== undefined &&
              response.statusCode >= 200 &&
              response.statusCode < 300;
          }
          const responseHeaders = forwardHeaders(response.headers);
          outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
          response.pipe(outgoing);
        },
      );
      request.on('error', () => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(502, { 'Content-Type': 'application/json' });
        }
        outgoing.end(
          '{"success":false,"errors":[{"message":"Cloudflare API proxy request failed"}]}',
        );
      });
      incoming.pipe(request);
    })().catch(() => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { 'Content-Type': 'application/json' });
      }
      outgoing.end('{"success":false,"errors":[{"message":"Cloudflare API proxy failed"}]}');
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    apiBaseUrl: `http://127.0.0.1:${address.port}${basePath}`,
    close: () => closeHttpServer(server),
    state,
  };
}

export async function withConditionalPlatformWorkerCreate<T>(
  accountId: string,
  workerName: string,
  operation: (apiBaseUrl: string) => Promise<T>,
  upstreamApiBaseUrl: string = resolvePinnedApiBaseUrl(),
): Promise<T> {
  const proxy = await startConditionalWorkerCreateProxy(upstreamApiBaseUrl, accountId, workerName);
  let result: T;
  try {
    result = await operation(proxy.apiBaseUrl);
  } finally {
    await proxy.close();
  }
  if (proxy.state.rejectedMutation) {
    throw new Error(
      `platform: Wrangler attempted unexpected mutation ${proxy.state.rejectedMutation} while conditionally creating new Worker ${workerName}; the mutation was blocked.`,
    );
  }
  if (!proxy.state.attempted || !proxy.state.forwarded) {
    throw new Error(
      `platform: Wrangler did not use the guarded create endpoint for new Worker ${workerName}; refusing an unverified deployment.`,
    );
  }
  if (proxy.state.conflictStatus !== null) {
    throw new Error(
      `platform: Worker ${workerName} was created concurrently (HTTP ${proxy.state.conflictStatus}); no existing Worker was changed. Re-run to inspect the collision.`,
    );
  }
  return result;
}

export async function runPlatformWranglerForConditionalCreate(
  operation: CloudflareOperation,
  accountId: string,
  cwd: string,
  capture: boolean,
  workerName: string,
  upstreamApiBaseUrl: string,
  apiToken?: string,
): Promise<CloudflareCommandResult> {
  return withConditionalPlatformWorkerCreate(
    accountId,
    workerName,
    (apiBaseUrl) =>
      runPlatformWranglerAtApiBase(operation, accountId, cwd, capture, apiBaseUrl, false, apiToken),
    upstreamApiBaseUrl,
  );
}
