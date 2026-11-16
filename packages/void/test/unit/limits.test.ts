import { describe, expect, it } from 'vite-plus/test';
import { UsageLimit, asUsageLimit, limitFromResponse } from '../../src/runtime/limits/index.ts';

describe('usage limits', () => {
  it('preserves the error type and identity when restoring structured limits', () => {
    const limit = new UsageLimit({
      resource: 'ai',
      reason: 'monthly_quota',
      message: 'No allowance',
    });
    expect(limit).toBeInstanceOf(Error);
    expect(asUsageLimit(limit)).toBe(limit);
    expect(
      asUsageLimit({
        code: 'usage_limit',
        resource: 'ai',
        reason: 'rate_limit',
        message: 'Try later',
      }),
    ).toBeInstanceOf(UsageLimit);
    expect(asUsageLimit(new Error('network'))).toBeNull();
  });
  it('preserves structured limits and retry metadata in public responses', async () => {
    const limit = new UsageLimit({
      resource: 'ai',
      reason: 'monthly_quota',
      message: 'No allowance',
      retryAt: '2099-01-01T00:00:00.000Z',
    });
    const response = limit.response({ message: 'Try again next month' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(await limitFromResponse(response, 'ai')).toMatchObject({
      reason: 'monthly_quota',
      message: 'Try again next month',
      retryAt: limit.retryAt,
    });
    expect(await limit.getResponse().json()).toMatchObject({ message: 'No allowance' });
  });
});
