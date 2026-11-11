import { PLATFORM_DISABLED_KEY } from '@void/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import app from '../../src/index.ts';
import { setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

describe('GET /.well-known/void-platform', () => {
  it('describes existing Void Cloud without exposing resource ids or credentials', async () => {
    const response = await app.fetch(
      new Request('https://api.void.cloud/.well-known/void-platform'),
      env,
    );
    expect(response.status).toBe(200);
    const document = await response.json<Record<string, unknown>>();
    expect(document).toMatchObject({
      apiUrl: 'https://api.void.cloud',
      applicationDomain: 'void.app',
      displayName: 'Void Cloud',
      proxyUrl: 'https://proxy.void.cloud',
      schemaVersion: 1,
      usageProtocolVersion: 2,
    });
    const serialized = JSON.stringify(document);
    expect(serialized).not.toMatch(/token|secret|accountId|zoneId|resource/i);
  });

  it('publishes a self-hosted installation identity and capability set', async () => {
    const selfHostedEnv = {
      ...env,
      PLATFORM_CAPABILITIES: JSON.stringify({
        ai: true,
        customDomains: false,
        email: false,
        githubActions: false,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
      }),
      PLATFORM_DISPLAY_NAME: 'Developer Platform Experience',
      PLATFORM_INSTALLATION_ID: 'dpx-a1b2c3d4',
      PLATFORM_VERSION: '0.10.13',
      PROXY_URL: 'https://proxy.platform.example.com',
      SITE_DOMAIN: 'apps.example.com',
    };
    const response = await app.fetch(
      new Request('https://platform.example.com/.well-known/void-platform'),
      selfHostedEnv,
    );
    expect(await response.json()).toMatchObject({
      apiUrl: 'https://platform.example.com',
      applicationDomain: 'apps.example.com',
      authenticationProviders: ['github'],
      displayName: 'Developer Platform Experience',
      installationId: 'dpx-a1b2c3d4',
      platformVersion: '0.10.13',
      proxyUrl: 'https://proxy.platform.example.com',
      usageProtocolVersion: 2,
    });

    const google = await app.fetch(
      new Request(
        'https://platform.example.com/auth/login?redirect=http://localhost:8787/callback&provider=google',
      ),
      selfHostedEnv,
    );
    expect(google.status).toBe(501);
    expect(await google.json()).toEqual({
      error: 'authentication provider unavailable',
      provider: 'google',
    });

    const managedBuild = await app.fetch(
      new Request('https://platform.example.com/github/install-url'),
      selfHostedEnv,
    );
    expect(managedBuild.status).toBe(501);
    expect(await managedBuild.json()).toMatchObject({ capability: 'managedBuilds' });

    const webhookIngress = await app.fetch(
      new Request('https://platform.example.com/internal/github-webhook', { method: 'POST' }),
      selfHostedEnv,
    );
    expect(webhookIngress.status).toBe(501);
    expect(await webhookIngress.json()).toMatchObject({ capability: 'managedBuilds' });
  });

  it('admits installer discovery while public traffic is disabled', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    try {
      const response = await app.fetch(
        new Request('https://api.void.cloud/.well-known/void-platform', {
          headers: { 'X-Void-Platform-Probe': 'probe-token' },
        }),
        {
          ...env,
          PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
          PLATFORM_INSTALLATION_ID: 'installation-id',
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ schemaVersion: 1 });
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('rejects the legacy public installer header while disabled', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    try {
      const response = await app.fetch(
        new Request('https://api.void.cloud/.well-known/void-platform', {
          headers: { 'X-Health-Check': 'void-admin' },
        }),
        {
          ...env,
          PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
          PLATFORM_INSTALLATION_ID: 'installation-id',
        },
      );
      expect(response.status).toBe(503);
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });
});
