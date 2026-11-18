import { readUsageLimit, usageLimitResponse, type UsageLimitData } from '@void/edge';
export { readUsageLimit, type UsageLimitData } from '@void/edge';

export class UsageLimit extends Error {
  override readonly name: string = 'UsageLimit';
  readonly code = 'usage_limit' as const;
  readonly resource: UsageLimitData['resource'];
  readonly reason: UsageLimitData['reason'];
  readonly retryAt?: string;
  constructor(data: Omit<UsageLimitData, 'code'>) {
    super(data.message);
    this.resource = data.resource;
    this.reason = data.reason;
    this.retryAt = data.retryAt;
  }
  response(options: { message?: string } = {}): Response {
    return usageLimitResponse({
      code: this.code,
      resource: this.resource,
      reason: this.reason,
      message: options.message ?? this.message,
      ...(this.retryAt ? { retryAt: this.retryAt } : {}),
    });
  }
  getResponse(): Response {
    return this.response();
  }
}

export function asUsageLimit(error: unknown): UsageLimit | null {
  if (error instanceof UsageLimit) {
    return error;
  }
  const data = readUsageLimit(error);
  return data ? new UsageLimit(data) : null;
}

export async function limitFromResponse(
  response: Response,
  resource: UsageLimitData['resource'],
): Promise<UsageLimit | null> {
  if (response.status !== 429) {
    return null;
  }
  const data = readUsageLimit(
    await response
      .clone()
      .json()
      .catch(() => null),
  );
  if (data) {
    return new UsageLimit(data);
  }
  const retry = response.headers.get('retry-after');
  const retryTime =
    retry === null
      ? NaN
      : /^\d+$/.test(retry)
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry);
  return new UsageLimit({
    resource,
    reason: 'rate_limit',
    message: `${resource === 'ai' ? 'AI' : 'Service'} is temporarily unavailable because its usage limit was reached.`,
    ...(Number.isFinite(retryTime) ? { retryAt: new Date(retryTime).toISOString() } : {}),
  });
}
