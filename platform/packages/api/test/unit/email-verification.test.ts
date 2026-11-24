/** Unit coverage for confirmation tokens and verification-email delivery. */

import { describe, expect, it, vi } from 'vite-plus/test';
import { signConfirmToken, verifyConfirmToken } from '../../src/auth/confirm-token.ts';
import { sendPlatformVerificationEmail } from '../../src/email/send-verification.ts';
import type { ApiEnv } from '../../src/env.ts';

const SECRET = 'test-platform-secret';

/**
 * The platform mail zone is a per-environment var, never a baked-in literal.
 * Staging's value here on purpose: a test pinned to production's domain would
 * pass against code that ignored the var entirely.
 */
const MAIL_DOMAIN = 'mail.voidcloud.dev';
const GATEWAY_ORIGIN = 'https://void-email-gateway-staging.voidzer0.workers.dev';

const DAY = 24 * 60 * 60;

function payload(overrides: Partial<Parameters<typeof signConfirmToken>[0]> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1 as const,
    pid: 'proj_x',
    did: 'edst_x',
    addr: 'a@b.com',
    iat: now,
    exp: now + DAY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// confirm-token
// ---------------------------------------------------------------------------

describe('signConfirmToken / verifyConfirmToken', () => {
  it('round-trips a well-formed payload', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signConfirmToken(payload({ iat: now, exp: now + DAY }), SECRET);
    const decoded = await verifyConfirmToken(token, SECRET, now);
    expect(decoded).toMatchObject({ v: 1, pid: 'proj_x', did: 'edst_x', addr: 'a@b.com' });
  });

  it('rejects a token signed with a different secret', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signConfirmToken(payload(), 'some-other-secret');
    expect(await verifyConfirmToken(token, SECRET, now)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    // Re-encode the payload with a different destination id but keep the
    // original signature — the classic "confirm someone else's row" attempt.
    const now = Math.floor(Date.now() / 1000);
    const token = await signConfirmToken(payload(), SECRET);
    const [body, sig] = token.split('.');
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(body.replaceAll('-', '+').replaceAll('_', '/')), (ch) =>
          ch.charCodeAt(0),
        ),
      ),
    ) as Record<string, unknown>;
    decoded.did = 'edst_someone_else';
    const reencoded = btoa(JSON.stringify(decoded))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');

    expect(await verifyConfirmToken(`${reencoded}.${sig}`, SECRET, now)).toBeNull();
  });

  it.each([
    ['no separator', 'notatoken'],
    ['three parts', 'a.b.c'],
    ['empty signature', 'abc.'],
    ['empty body', '.abc'],
  ])('rejects a structurally invalid token (%s)', async (_label, token) => {
    expect(await verifyConfirmToken(token, SECRET)).toBeNull();
  });

  it('rejects a payload with the wrong schema version', async () => {
    const now = Math.floor(Date.now() / 1000);
    // A future v2 token must not be accepted by a v1 verifier — the whole
    // point of the version field is that a shape change invalidates old links.
    const token = await signConfirmToken(
      { ...payload(), v: 2 } as unknown as Parameters<typeof signConfirmToken>[0],
      SECRET,
    );
    expect(await verifyConfirmToken(token, SECRET, now)).toBeNull();
  });

  it('rejects an expired token, including exactly at exp', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await signConfirmToken(payload({ iat: now - DAY, exp: now - 1 }), SECRET);
    expect(await verifyConfirmToken(expired, SECRET, now)).toBeNull();

    // `exp <= now` — the boundary second is already dead.
    const atBoundary = await signConfirmToken(payload({ iat: now - DAY, exp: now }), SECRET);
    expect(await verifyConfirmToken(atBoundary, SECRET, now)).toBeNull();

    // One second of life left.
    const alive = await signConfirmToken(payload({ iat: now - DAY, exp: now + 1 }), SECRET);
    expect(await verifyConfirmToken(alive, SECRET, now)).not.toBeNull();
  });

  it('accepts an iat up to 60s in the future (clock skew between workers)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signConfirmToken(payload({ iat: now + 30, exp: now + DAY }), SECRET);
    const decoded = await verifyConfirmToken(token, SECRET, now);
    expect(decoded).not.toBeNull();
    expect(decoded?.iat).toBe(now + 30);
  });

  it('rejects an iat past the 60s skew tolerance', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 61s: the boundary. Anything beyond it is a forged token or an issuing
    // worker whose clock is wrong enough that its tokens should not be honored.
    const atBoundary = await signConfirmToken(payload({ iat: now + 61, exp: now + DAY }), SECRET);
    expect(await verifyConfirmToken(atBoundary, SECRET, now)).toBeNull();

    const wayOut = await signConfirmToken(payload({ iat: now + 5 * 60, exp: now + DAY }), SECRET);
    expect(await verifyConfirmToken(wayOut, SECRET, now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verification-email delivery
// ---------------------------------------------------------------------------

type SentMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

function verificationEnv(overrides: Partial<ApiEnv['Bindings']> = {}) {
  const sent: Array<SentMessage> = [];
  const send = vi.fn(async (message: SentMessage) => {
    sent.push(message);
  });
  return {
    env: {
      EMAIL_SIGNING_SECRET: SECRET,
      EMAIL: { send } as unknown as SendEmail,
      EMAIL_SENDER_DOMAIN: MAIL_DOMAIN,
      EMAIL_GATEWAY_ORIGIN: GATEWAY_ORIGIN,
      PLATFORM_ENV: 'staging',
      ...overrides,
    } as unknown as ApiEnv['Bindings'],
    send,
    sent,
  };
}

async function sendVerification(env: ApiEnv['Bindings'], token = 'confirm-token.signature') {
  await sendPlatformVerificationEmail(
    env,
    { id: 'proj_1', slug: 'acme' },
    'recipient@example.com',
    token,
  );
}

describe('sendPlatformVerificationEmail', () => {
  it('uses the API email binding with the configured sender and public gateway link', async () => {
    const { env, sent } = verificationEnv();
    const outboundFetch = vi.fn();
    vi.stubGlobal('fetch', outboundFetch);
    try {
      await sendVerification(env);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(outboundFetch).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: `noreply@${MAIL_DOMAIN}`,
      to: 'recipient@example.com',
      subject: '[acme] wants permission to email you',
    });
    expect(sent[0].text).toContain(
      `${GATEWAY_ORIGIN}/email/destinations/confirm?token=confirm-token.signature`,
    );
    expect(sent[0].text).not.toContain('api.staging.void.cloud');
  });

  it('uses the configured self-hosted public gateway instead of its protected API origin', async () => {
    const { env, sent } = verificationEnv({
      AUTH_REDIRECT_URI: 'https://control.example.com/auth/callback',
      EMAIL_GATEWAY_ORIGIN: 'https://mail-gateway.example.workers.dev',
      PLATFORM_ENV: 'production',
      PLATFORM_INSTALLATION_ID: 'installation_1',
    });

    await sendVerification(env, 'token');

    expect(sent[0].text).toContain(
      'https://mail-gateway.example.workers.dev/email/destinations/confirm?token=token',
    );
    expect(sent[0].text).not.toContain('control.example.com');
  });

  it.each([
    'http://gateway.example.com',
    'https://gateway.example.com/path',
    'https://gateway.example.com/',
    'https://user@gateway.example.com',
    'https://gateway.example.com?next=https://attacker.example',
  ])('rejects an invalid EMAIL_GATEWAY_ORIGIN before delivery: %s', async (origin) => {
    const { env, send } = verificationEnv({ EMAIL_GATEWAY_ORIGIN: origin });
    await expect(sendVerification(env)).rejects.toThrow('EMAIL_GATEWAY_ORIGIN');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['EMAIL_SENDER_DOMAIN', { EMAIL_SENDER_DOMAIN: undefined }],
    ['EMAIL_GATEWAY_ORIGIN', { EMAIL_GATEWAY_ORIGIN: undefined }],
    ['EMAIL binding', { EMAIL: undefined }],
  ])('fails before delivery when %s is missing', async (_label, overrides) => {
    const { env, send } = verificationEnv(overrides);
    await expect(sendVerification(env)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('logs and swallows a delivery failure so the destination stays pending', async () => {
    const { env } = verificationEnv({
      EMAIL: {
        send: vi.fn(async () => {
          throw new Error('provider unavailable');
        }),
      } as unknown as SendEmail,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(sendVerification(env)).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('project=proj_1 address=recipient@example.com'),
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });
});
