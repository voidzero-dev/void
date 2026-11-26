import { describe, it, expect } from 'vite-plus/test';
import { isAllowedRedirect } from '../../src/routes/auth.ts';

describe('isAllowedRedirect', () => {
  it('allows localhost with any port', () => {
    expect(isAllowedRedirect('http://localhost:3000/callback')).toBe(true);
    expect(isAllowedRedirect('http://localhost:8080/callback')).toBe(true);
  });

  it('allows 127.0.0.1 with any port', () => {
    expect(isAllowedRedirect('http://127.0.0.1:3000/callback')).toBe(true);
    expect(isAllowedRedirect('http://127.0.0.1:5173/')).toBe(true);
  });

  it('allows exact dashboard origin', () => {
    expect(isAllowedRedirect('https://dash.void.cloud/callback')).toBe(true);
    expect(isAllowedRedirect('https://dash.void.cloud/login?next=/projects')).toBe(true);
  });

  it('allows custom dashboard URL (staging)', () => {
    expect(
      isAllowedRedirect('https://dash.staging.void.cloud/cb', 'https://dash.staging.void.cloud'),
    ).toBe(true);
  });

  it('does not inherit the hosted dashboard in a self-hosted installation', () => {
    expect(
      isAllowedRedirect('https://dash.void.cloud/auth/callback', undefined, 'example-a1b2c3d4'),
    ).toBe(false);
    expect(
      isAllowedRedirect(
        'https://company-dashboard.example.com/auth/callback',
        'https://company-dashboard.example.com',
        'example-a1b2c3d4',
      ),
    ).toBe(true);
  });

  it('admits only the configured self-hosted dashboard origin including its port', () => {
    const dashboard = 'https://void-e2e-dashboard.readwise.dev:8443';
    expect(
      isAllowedRedirect(
        `${dashboard}/auth/callback?login_nonce=real-browser-nonce`,
        dashboard,
        'isolated-installation',
      ),
    ).toBe(true);
    for (const callback of [
      'https://void-e2e-dashboard.readwise.dev/auth/callback',
      'https://void-e2e-dashboard.readwise.dev.attacker.example:8443/auth/callback',
      'https://other.readwise.dev:8443/auth/callback',
      'http://void-e2e-dashboard.readwise.dev:8443/auth/callback',
    ]) {
      expect(isAllowedRedirect(callback, dashboard, 'isolated-installation')).toBe(false);
    }
  });

  it('rejects subdomain prefix attack', () => {
    expect(isAllowedRedirect('https://dash.void.cloud.attacker.com/steal')).toBe(false);
  });

  it('rejects evil subdomain of dashboard', () => {
    expect(isAllowedRedirect('https://evil.dash.void.cloud/callback')).toBe(false);
  });

  it('rejects https localhost', () => {
    expect(isAllowedRedirect('https://localhost:3000/callback')).toBe(false);
  });

  it('rejects http for dashboard', () => {
    expect(isAllowedRedirect('http://dash.void.cloud/callback')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isAllowedRedirect('not-a-url')).toBe(false);
    expect(isAllowedRedirect('')).toBe(false);
  });

  it('rejects javascript: protocol', () => {
    expect(isAllowedRedirect('javascript:alert(1)')).toBe(false);
  });

  it('rejects unrelated origins', () => {
    expect(isAllowedRedirect('https://attacker.com/callback')).toBe(false);
  });
});
