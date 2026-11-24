import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformAccessVerifier } from '../../src/auth/access.ts';

let key: CryptoKey;
let jwk: Record<string, unknown>;
const protection = {
  teamDomain: 'https://company.cloudflareaccess.com',
  applications: [
    { origin: 'https://api.example.com', audience: 'api-audience' },
    { origin: 'https://proxy.example.com', audience: 'proxy-audience' },
  ],
};
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', kid: 'key-1', use: 'sig' };
});
function token(claims: Record<string, unknown> = {}, signingKey = key) {
  return new SignJWT({
    iss: protection.teamDomain,
    aud: ['api-audience'],
    sub: 'employee',
    type: 'app',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    email: 'person@example.com',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .sign(signingKey);
}
function fixture() {
  const request = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    expect(input.toString()).toBe('https://company.cloudflareaccess.com/cdn-cgi/access/certs');
    expect(options?.redirect).toBe('manual');
    return Response.json({ keys: [jwk] });
  });
  return { verifier: new PlatformAccessVerifier(request as typeof fetch), request };
}
describe('Cloudflare Access assertions', () => {
  it('verifies human identity and caches signing keys', async () => {
    const { verifier, request } = fixture();
    const assertion = await token();
    expect(
      await verifier.verify('https://api.example.com/auth/login', assertion, protection),
    ).toEqual({
      kind: 'human',
      issuer: protection.teamDomain,
      subject: 'employee',
      email: 'person@example.com',
    });
    await verifier.verify('https://api.example.com/me', assertion, protection);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('classifies service credentials separately from people', async () => {
    const { verifier } = fixture();
    const assertion = await token({ sub: '', email: undefined, common_name: 'build-ci.access' });
    expect(await verifier.verify('https://api.example.com/health', assertion, protection)).toEqual({
      kind: 'service',
      issuer: protection.teamDomain,
      serviceId: 'build-ci.access',
    });
  });
  it.each([
    { aud: ['another-application'] },
    { iss: 'https://other.cloudflareaccess.com' },
    { type: 'org' },
    { exp: 1 },
    { exp: undefined },
    { sub: '' },
    { email: undefined },
    { iat: 9_999_999_999 },
    { common_name: 'machine', sub: 'employee' },
  ])('rejects invalid or ambiguous claims %j', async (claims) => {
    await expect(
      fixture().verifier.verify('https://api.example.com/', await token(claims), protection),
    ).rejects.toThrow('valid Cloudflare Access identity');
  });
  it('pins tokens to the actual origin and rejects alternate URLs before fetching keys', async () => {
    const { verifier, request } = fixture();
    const assertion = await token();
    await expect(
      verifier.verify('https://alternate.workers.dev/', assertion, protection),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(
      verifier.verify('https://proxy.example.com/', assertion, protection),
    ).rejects.toThrow();
  });
  it('rejects invalid signatures', async () => {
    const other = await generateKeyPair('RS256');
    await expect(
      fixture().verifier.verify(
        'https://api.example.com/',
        await token({}, other.privateKey),
        protection,
      ),
    ).rejects.toThrow();
  });
  it('rejects missing or oversized assertions without network requests', async () => {
    const { verifier, request } = fixture();
    for (const assertion of [undefined, 'x'.repeat(32 * 1024 + 1)]) {
      await expect(
        verifier.verify('https://api.example.com/', assertion, protection),
      ).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });
});
