import { isRecord } from '@void/deploy-core';

/** Shared between the SDK, edge admission and Pages clients. */
export type UsageLimitData = {
  code: 'usage_limit';
  resource: 'ai' | 'sandbox' | 'requests' | 'execution';
  reason: 'monthly_quota' | 'rate_limit' | 'concurrency' | 'runtime_budget' | 'cpu';
  message: string;
  retryAt?: string;
};

export function readUsageLimit(value: unknown): UsageLimitData | null {
  if (!isRecord(value)) {
    return null;
  }
  const { code, message, resource, reason, retryAt } = value;
  if (
    code !== 'usage_limit' ||
    typeof message !== 'string' ||
    (resource !== 'ai' &&
      resource !== 'sandbox' &&
      resource !== 'requests' &&
      resource !== 'execution') ||
    (reason !== 'monthly_quota' &&
      reason !== 'rate_limit' &&
      reason !== 'concurrency' &&
      reason !== 'runtime_budget' &&
      reason !== 'cpu')
  ) {
    return null;
  }
  return {
    code,
    resource,
    reason,
    message,
    ...(typeof retryAt === 'string' && Number.isFinite(Date.parse(retryAt)) ? { retryAt } : {}),
  };
}

export function usageLimitResponse(limit: UsageLimitData): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (limit.retryAt && Number.isFinite(Date.parse(limit.retryAt))) {
    headers.set(
      'Retry-After',
      String(Math.max(0, Math.ceil((Date.parse(limit.retryAt) - Date.now()) / 1000))),
    );
  }
  return Response.json(limit, { status: 429, headers });
}
