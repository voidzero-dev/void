import { isRecord } from '@void/deploy-core';
import { getVoidUserAgent } from './cf-user-agent.ts';

/** Version uploads leave Worker-wide settings untouched; publish only explicit configuration. */
export async function publishCloudflareWorkerSettings(options: {
  apiBaseUrl: string;
  accountId: string;
  workerName: string;
  observability?: unknown;
  logpush?: unknown;
  headers: Record<string, string>;
}): Promise<void> {
  if (options.observability !== undefined && !isRecord(options.observability)) {
    throw new Error('The Cloudflare Worker observability settings were not readable.');
  }
  if (options.logpush !== undefined && typeof options.logpush !== 'boolean') {
    throw new Error('The Cloudflare Worker Logpush setting was not readable.');
  }
  const settings = {
    ...(options.observability === undefined ? {} : { observability: options.observability }),
    ...(options.logpush === undefined ? {} : { logpush: options.logpush }),
  };
  if (Object.keys(settings).length === 0) {
    return;
  }
  const endpoint = `${options.apiBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(options.accountId)}/workers/scripts/${encodeURIComponent(options.workerName)}/script-settings`;
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      'User-Agent': getVoidUserAgent(),
      ...options.headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(settings),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await response.json();
  if (!response.ok || !isRecord(body) || body.success !== true) {
    throw new Error(`Cloudflare did not update Worker settings (HTTP ${response.status}).`);
  }
}
