import { PLATFORM_AUTH_SETUP_PROOF_PREFIX } from '@void/platform';
import { describe, expect, it, vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import {
  initializeInstalledPlatformAuthentication,
  resumeInstalledPlatformAuthentication,
} from '../../src/cli/platform-auth-bootstrap.ts';

const setup = {
  connections: [
    {
      configuration: {
        id: 'company',
        kind: 'oidc',
        label: 'Company',
        clientId: 'client',
        issuer: 'https://identity.example.com',
      },
      clientSecret: 'provider-secret',
    },
  ],
  administratorConnectionId: 'company',
  bootstrapCredentialHash: 'a'.repeat(64),
  admission: { mode: 'restricted' },
  protection: null,
};
describe('installer authentication handoff', () => {
  it('rotates an expired setup code only after checkpointing, and resumes the exact replacement after a lost response', async () => {
    let saved: { authenticationSetupJson: string; authBootstrapCode: string } | undefined;
    const initialize = vi.fn(async (_url: string, _id: string, _token: string, json: string) => {
      if (initialize.mock.calls.length === 1) {
        return { setupPending: true, expiresAt: new Date(0).toISOString() };
      }
      expect(saved?.authenticationSetupJson).toBe(json);
      expect(JSON.parse(json)).toMatchObject({ resetPending: true });
      throw new Error('response lost');
    });
    await expect(
      resumeInstalledPlatformAuthentication(
        {
          apiUrl: 'https://api.example.com',
          installationId: 'installation',
          setupToken: 'key',
          setupJson: JSON.stringify(setup),
          checkpoint: (replacement) => {
            saved = replacement;
          },
        },
        initialize,
      ),
    ).rejects.toThrow('response lost');
    expect(saved?.authBootstrapCode).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(saved!.authenticationSetupJson).bootstrapCredentialHash).not.toBe(
      setup.bootstrapCredentialHash,
    );
    const checkpoint = vi.fn();
    const retry = vi.fn(async () => ({
      setupPending: true,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }));
    await resumeInstalledPlatformAuthentication(
      {
        apiUrl: 'https://api.example.com',
        installationId: 'installation',
        setupToken: 'key',
        setupJson: saved!.authenticationSetupJson,
        checkpoint,
      },
      retry,
    );
    expect(retry).toHaveBeenCalledWith(
      'https://api.example.com',
      'installation',
      'key',
      saved!.authenticationSetupJson,
    );
    expect(checkpoint).not.toHaveBeenCalled();
  });
  it('never rotates setup after the first administrator has consumed it', async () => {
    const checkpoint = vi.fn();
    const initialize = vi.fn(async () => ({ setupPending: false, expiresAt: null }));
    await resumeInstalledPlatformAuthentication(
      {
        apiUrl: 'https://api.example.com',
        installationId: 'installation',
        setupToken: 'key',
        setupJson: JSON.stringify(setup),
        checkpoint,
      },
      initialize,
    );
    expect(checkpoint).not.toHaveBeenCalled();
    expect(initialize).toHaveBeenCalledTimes(1);
  });
  it('binds setup authority to the installation and complete body without using health credentials', async () => {
    const request = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      expect(url).toBe('https://api.example.com/internal/platform/auth-initialize');
      expect(options?.redirect).toBe('manual');
      const headers = new Headers(options?.headers);
      expect(headers.has('X-Void-Platform-Probe')).toBe(false);
      expect(headers.get('X-Void-Auth-Setup')).not.toBe('setup-key');
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode('setup-key'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      expect(
        await crypto.subtle.verify(
          'HMAC',
          key,
          Buffer.from(headers.get('X-Void-Auth-Setup')!, 'base64url'),
          new TextEncoder().encode(
            `${PLATFORM_AUTH_SETUP_PROOF_PREFIX}\ninstallation\n${options?.body}`,
          ),
        ),
      ).toBe(true);
      return Response.json({
        setupPending: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    expect(
      await initializeInstalledPlatformAuthentication(
        'https://api.example.com',
        'installation',
        'setup-key',
        JSON.stringify(setup),
        request,
      ),
    ).toMatchObject({ setupPending: true });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not follow redirects or retry a failed setup write', async () => {
    const request = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: 'https://another.example.com' } }),
    );
    await expect(
      initializeInstalledPlatformAuthentication(
        'https://api.example.com',
        'installation',
        'setup-key',
        JSON.stringify(setup),
        request,
      ),
    ).rejects.toThrow('HTTP 302');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
