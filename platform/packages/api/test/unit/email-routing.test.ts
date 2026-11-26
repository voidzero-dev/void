import { describe, expect, it } from 'vite-plus/test';
import { CloudflareApiError } from '../../src/provisioning/cloudflare-api.ts';
import { isAlreadyExistsError } from '../../src/provisioning/email-routing.ts';

describe('Cloudflare email destination errors', () => {
  it('recognizes the structured already-exists code without depending on message text', () => {
    expect(
      isAlreadyExistsError(new CloudflareApiError('localized provider error', 400, [10_037])),
    ).toBe(true);
    expect(
      isAlreadyExistsError(new CloudflareApiError('localized provider error', 400, [1000])),
    ).toBe(false);
  });
});
