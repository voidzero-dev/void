import { describe, expect, it, vi } from 'vite-plus/test';
import {
  ensureUsageSigningKey,
  signUsageEvent,
  verifyUsageEnvelope,
} from '../../src/usage-auth.ts';

describe('usage signing key bootstrap', () => {
  it('derives the same purpose-separated key in concurrent cold isolates', async () => {
    const puts: Array<string> = [];
    const routing = {
      get: vi.fn(async () => null),
      put: vi.fn(async (_key: string, value: string) => {
        puts.push(value);
      }),
    } as unknown as KVNamespace;

    const [left, right] = await Promise.all([
      ensureUsageSigningKey(routing, 'shared-jwt-secret'),
      ensureUsageSigningKey(routing, 'shared-jwt-secret'),
    ]);

    expect(left).toBe(right);
    expect(puts).toEqual([left, left]);
    expect(left).not.toBe('shared-jwt-secret');
  });

  it('preserves an existing key across JWT rotation', async () => {
    const routing = {
      get: vi.fn(async () => 'stable-existing-key'),
      put: vi.fn(async () => {}),
    } as unknown as KVNamespace;

    await expect(ensureUsageSigningKey(routing, 'rotated-jwt-secret')).resolves.toBe(
      'stable-existing-key',
    );
    expect(routing.put).not.toHaveBeenCalled();
  });
});

describe('usage envelopes', () => {
  it('accepts a valid protocol-v1 envelope while protocol-v2 producers roll out', async () => {
    const source = 'dispatch';
    const eventId = 'event-v1';
    const event = { projectId: 'project-1', requests: 1, responseBytes: 0 };
    const key = 'key';
    const signingKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = (Buffer as BufferConstructor)
      .from(
        await crypto.subtle.sign(
          'HMAC',
          signingKey,
          new TextEncoder().encode(JSON.stringify([1, source, eventId, event])),
        ),
      )
      .toString('base64url');

    await expect(
      verifyUsageEnvelope({ version: 1, source, eventId, event, signature }, key),
    ).resolves.toEqual({ version: 1, source, eventId, event, signature });
  });

  it('rejects a payload changed after signing', async () => {
    const envelope = await signUsageEvent('key', 'dispatch', 'event-1', {
      projectId: 'project-1',
      requests: 1,
      responseBytes: 0,
    });

    await expect(
      verifyUsageEnvelope({ ...envelope, event: { ...envelope.event, requests: -1 } }, 'key'),
    ).resolves.toBeNull();
  });
});
