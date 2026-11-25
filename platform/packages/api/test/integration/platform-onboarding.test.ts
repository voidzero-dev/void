import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from '@void/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import app from '../../src/index.ts';
import { setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});

describe('platform onboarding pages', () => {
  it('welcomes visitors at the API root with this platform’s connection instructions', async () => {
    const response = await app.fetch(
      new Request('https://alias.example.com/', {
        headers: { 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'http' },
      }),
      {
        ...env,
        AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
        PLATFORM_DISPLAY_NAME: '<Example Platform>',
        PLATFORM_INSTALLATION_ID: 'example-installation',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('<h1 id="void-auth-title">Welcome to &lt;Example Platform&gt;</h1>');
    expect(html).toContain('<title>Welcome · &lt;Example Platform&gt; · Void</title>');
    expect(html).toContain('npm install -g void');
    expect(html).toContain('void connect &#39;api.example.com&#39;');
    expect(html).toContain('href="/admin/"');
    expect(html).toContain('href="https://void.cloud/guide/quickstart"');
    expect(html).not.toContain('<Example Platform>');
    expect(html).not.toContain('attacker.example');
    expect(html).not.toContain('alias.example.com');
    expect(html).not.toContain('<script');
  });

  it('keeps the welcome page behind the installation traffic gate', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE);
    try {
      const response = await app.fetch(new Request('https://api.example.com/'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'example-installation',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Platform disabled' });
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('shows the configured platform identity and connection, ignoring forwarded origins', async () => {
    const response = await app.fetch(
      new Request('https://alias.example.com/invite', {
        headers: {
          Host: 'attacker.example',
          'X-Forwarded-Host': 'attacker.example',
          'X-Forwarded-Proto': 'http',
        },
      }),
      {
        ...env,
        AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
        PLATFORM_DISPLAY_NAME: '<Example Platform>',
        PLATFORM_INSTALLATION_ID: 'example-installation',
      },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('&lt;Example Platform&gt;');
    expect(html).toContain('<title>Get Started · &lt;Example Platform&gt; · Void</title>');
    expect(html).not.toContain('<Example Platform>');
    // `escapeHtml` escapes the quotes too; the browser renders them back.
    expect(html).toContain('void connect &#39;api.example.com&#39;');
    expect(html).not.toContain('attacker.example');
    expect(html).not.toContain('alias.example.com');
    expect(html).not.toContain('void auth login');
    expect(html).not.toContain('void deploy');
    expect(html).toContain('void project link');
    expect(html).not.toMatch(/private beta|discord|early-access/i);
  });

  it('uses the actual API request origin when no callback is configured', async () => {
    const response = await app.fetch(
      new Request('https://api.example.com/invite', {
        headers: { Host: 'attacker.example', 'X-Forwarded-Host': 'attacker.example' },
      }),
      { ...env, PLATFORM_INSTALLATION_ID: 'example-installation' },
    );
    const html = await response.text();
    expect(html).toContain('Get Started with Void Platform');
    // `escapeHtml` escapes the quotes too; the browser renders them back.
    expect(html).toContain('void connect &#39;api.example.com&#39;');
    expect(html).not.toContain('attacker.example');
  });

  it('turns a project invitation link into CLI acceptance instructions', async () => {
    const response = await app.fetch(
      new Request('https://api.example.com/invite?project-invitation=pinv_a1b2c3d4e5f6'),
      {
        ...env,
        AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
        PLATFORM_INSTALLATION_ID: 'example-installation',
      },
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>Accept Project Invitation · Void Platform</title>');
    expect(html).toContain('void connect &#39;api.example.com&#39;');
    expect(html).toContain('void project team accept pinv_a1b2c3d4e5f6');
    expect(html).toContain('The CLI checks that it is still valid');
    expect(html).toContain('run <code>void project link</code> if it is not linked yet');
    expect(html).toContain('use a separate checkout without a <code>.void/project.json</code>');
    expect(html).toContain('Accepting an invitation keeps existing project links.');
    expect(html).not.toContain('choose a project on this platform before deploying');
    expect(html).not.toContain('href="/admin');
  });

  it('does not render shell instructions for a malformed invitation id', async () => {
    const response = await app.fetch(
      new Request(
        'https://api.example.com/invite?project-invitation=%24%28open%20https%3A%2F%2Fevil.example%29',
      ),
      {
        ...env,
        AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
        PLATFORM_INSTALLATION_ID: 'example-installation',
      },
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>Get Started · Void Platform</title>');
    expect(html).not.toContain('void project team accept');
    expect(html).not.toContain('evil.example');
  });

  it.each(['/', '/invite', '/signup-restricted'])(
    'uses a generic name for source deployments at %s',
    async (path) => {
      const response = await app.fetch(
        new Request(`https://api.example.com${path}`, {
          headers: { Host: 'api.void.cloud', 'X-Forwarded-Host': 'api.void.cloud' },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Void Platform');
      expect(html).not.toContain('Void Cloud');
      if (path === '/') {
        expect(html).toContain('void connect &#39;api.example.com&#39;');
      }
    },
  );

  it.each(['https://api.void.cloud', 'https://api.staging.void.cloud'])(
    'preserves the hosted name at %s',
    async (origin) => {
      const response = await app.fetch(new Request(`${origin}/signup-restricted`), env);
      expect(await response.text()).toContain(
        'New accounts on Void Cloud require administrator approval.',
      );
    },
  );

  it('explains administrator-controlled access without a private beta claim', async () => {
    const response = await app.fetch(new Request('https://api.example.com/signup-restricted'), {
      ...env,
      PLATFORM_DISPLAY_NAME: '<Example Platform>',
      PLATFORM_INSTALLATION_ID: 'example-installation',
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      'New accounts on &lt;Example Platform&gt; require administrator approval.',
    );
    expect(html).toContain('verified email address');
    expect(html).not.toMatch(/private beta|check back later/i);
  });
});
