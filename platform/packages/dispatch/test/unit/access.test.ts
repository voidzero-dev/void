import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { ProjectAccessVerifier, resolveAccessAudience } from '../../src/access.ts';

const teamDomain = 'https://company.cloudflareaccess.com';
let privateKey: CryptoKey;
let jwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'key-1', use: 'sig' };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const routing = {
  teamDomain,
  audiences: [
    { hostname: '*.apps.example.com', audience: 'wildcard-aud' },
    { hostname: 'void-123456abcdef-*.my-account.workers.dev', audience: 'workers-dev-aud' },
    { hostname: 'custom.example.net', audience: 'custom-aud' },
    { hostname: 'custom.apps.example.com', audience: 'custom-aud' },
    {
      hostname: 'void-123456abcdef-custom-123456abcdef.my-account.workers.dev',
      audience: 'custom-aud',
    },
  ],
};

async function assertion(audience = 'wildcard-aud', claims: Record<string, unknown> = {}) {
  return new SignJWT({
    iss: teamDomain,
    aud: [audience],
    sub: 'employee',
    type: 'app',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .sign(privateKey);
}

describe('project Access verification', () => {
  it('matches exact destinations before one-label wildcards', () => {
    expect(resolveAccessAudience('custom.example.net', routing)).toBe('custom-aud');
    expect(resolveAccessAudience('custom.apps.example.com', routing)).toBe('custom-aud');
    expect(
      resolveAccessAudience(
        'void-123456abcdef-custom-123456abcdef.my-account.workers.dev',
        routing,
      ),
    ).toBe('custom-aud');
    expect(resolveAccessAudience('project.apps.example.com', routing)).toBe('wildcard-aud');
    expect(resolveAccessAudience('nested.project.apps.example.com', routing)).toBeNull();
    expect(resolveAccessAudience('apps.example.com', routing)).toBeNull();
  });

  it('matches the installation project prefix case-insensitively', () => {
    expect(
      resolveAccessAudience('void-123456abcdef-blog-789abc.my-account.workers.dev', routing),
    ).toBe('workers-dev-aud');
    expect(
      resolveAccessAudience('VOID-123456ABCDEF-BLOG-789ABC.MY-ACCOUNT.WORKERS.DEV', routing),
    ).toBe('workers-dev-aud');
  });

  it.each([
    'void-team-api.my-account.workers.dev',
    'void-team-proxy.my-account.workers.dev',
    'unrelated-worker.my-account.workers.dev',
    'void-fedcba654321-blog-789abc.my-account.workers.dev',
    'void-123456abcdefother-blog-789abc.my-account.workers.dev',
    'other-void-123456abcdef-blog-789abc.my-account.workers.dev',
    'nested.void-123456abcdef-blog-789abc.my-account.workers.dev',
    'void-123456abcdef-blog.nested.my-account.workers.dev',
    'void-123456abcdef-blog-789abc.other-account.workers.dev',
    'void-123456abcdef-blog-789abc.my-account.workers.dev.attacker.test',
    'my-account.workers.dev',
  ])('excludes hosts outside the project wildcard: %s', (hostname) => {
    expect(resolveAccessAudience(hostname, routing)).toBeNull();
  });

  it.each([
    'void-*-*.my-account.workers.dev',
    'void-*.nested.*.workers.dev',
    'void.*.my-account.workers.dev',
  ])('does not accept unsupported wildcard patterns: %s', (hostname) => {
    expect(
      resolveAccessAudience('void-123456abcdef-blog.my-account.workers.dev', {
        teamDomain,
        audiences: [{ hostname, audience: 'invalid-aud' }],
      }),
    ).toBeNull();
  });

  it('verifies the scoped workers.dev audience', async () => {
    const request = vi.fn(async () => Response.json({ keys: [jwk] }));
    const verifier = new ProjectAccessVerifier(request as typeof fetch);
    const hostname = 'void-123456abcdef-blog-789abc.my-account.workers.dev';

    await expect(
      verifier.verify(hostname, await assertion('workers-dev-aud'), routing),
    ).resolves.toBe(true);
    await expect(verifier.verify(hostname, await assertion(), routing)).resolves.toBe(false);
  });

  it('verifies Access app assertions and caches the signing keys', async () => {
    const request = vi.fn(async () => Response.json({ keys: [jwk] }));
    const verifier = new ProjectAccessVerifier(request as typeof fetch);
    const token = await assertion();

    await expect(verifier.verify('project.apps.example.com', token, routing)).resolves.toBe(true);
    await expect(verifier.verify('project.apps.example.com', token, routing)).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });

  it('fails closed for absent, mismatched, future, or non-app assertions', async () => {
    const request = vi.fn(async () => Response.json({ keys: [jwk] }));
    const verifier = new ProjectAccessVerifier(request as typeof fetch);

    await expect(verifier.verify('project.apps.example.com', null, routing)).resolves.toBe(false);
    await expect(
      verifier.verify('project.apps.example.com', await assertion('another-aud'), routing),
    ).resolves.toBe(false);
    await expect(
      verifier.verify(
        'project.apps.example.com',
        await assertion('wildcard-aud', { iat: Math.floor(Date.now() / 1000) + 120 }),
        routing,
      ),
    ).resolves.toBe(false);
    await expect(
      verifier.verify(
        'project.apps.example.com',
        await assertion('wildcard-aud', { type: 'org' }),
        routing,
      ),
    ).resolves.toBe(false);
  });

  it('calls the global fetch without binding it to the verifier by default', async () => {
    const requests: Array<string> = [];
    // Workers rejects a host fetch invoked with any receiver other than the global object.
    vi.stubGlobal('fetch', function (this: unknown, input: string | URL | Request) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      }
      requests.push(input.toString());
      return Promise.resolve(Response.json({ keys: [jwk] }));
    });
    const verifier = new ProjectAccessVerifier();

    await expect(
      verifier.verify('project.apps.example.com', await assertion(), routing),
    ).resolves.toBe(true);
    expect(requests).toEqual([`${teamDomain}/cdn-cgi/access/certs`]);
  });

  it('rejects redirects from the signing-key endpoint', async () => {
    const request = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } }),
    );
    const verifier = new ProjectAccessVerifier(request as typeof fetch);

    await expect(
      verifier.verify('project.apps.example.com', await assertion(), routing),
    ).resolves.toBe(false);
  });
});
