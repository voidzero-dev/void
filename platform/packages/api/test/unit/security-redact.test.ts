import { describe, expect, it } from 'vite-plus/test';
import {
  createSecurityRedactor,
  isRedactableSecret,
  secretForms,
} from '../../src/security/input/redact.ts';

describe('isRedactableSecret', () => {
  it('keeps short or plain values (edge #30)', () => {
    for (const value of [
      'true',
      '1',
      'admin',
      'production',
      'abcdefgh',
      'ABCDEFGHIJ',
      '12345678',
    ]) {
      expect(isRedactableSecret(value), value).toBe(false);
    }
  });

  it('redacts 8+ characters with two kinds of character', () => {
    for (const value of ['abcd1234', 'sk_live_abcdef', 'Passw0rd', 'ABCD-EFGH']) {
      expect(isRedactableSecret(value), value).toBe(true);
    }
  });
});

describe('createSecurityRedactor', () => {
  const secret = { name: 'STRIPE_KEY', value: 'sk_live_a/b+c"d=1' };

  it('replaces the value in all four forms', () => {
    const forms = secretForms(secret.value);
    expect(forms).toEqual(
      expect.arrayContaining([
        secret.value,
        'sk_live_a/b+c\\"d=1',
        btoa(secret.value),
        encodeURIComponent(secret.value),
      ]),
    );
    const redactor = createSecurityRedactor([secret]);
    const text = [
      `const raw = '${secret.value}';`,
      `{"sourcesContent":["const k = \\"sk_live_a/b+c\\\\\\"d=1\\""]}`,
      `const json = "${JSON.stringify(secret.value).slice(1, -1)}";`,
      `const b64 = '${btoa(secret.value)}';`,
      `fetch('/x?key=${encodeURIComponent(secret.value)}');`,
    ].join('\n');
    const out = redactor.redact(text);
    for (const form of forms) {
      expect(out).not.toContain(form);
    }
    expect(out).toContain('[REDACTED:STRIPE_KEY]');
    expect(redactor.hits()).toBe(1);
  });

  it('leaves short values and unrelated text alone, and counts each secret once', () => {
    const redactor = createSecurityRedactor([
      { name: 'MODE', value: 'production' },
      { name: 'FLAG', value: 'true' },
      { name: 'TOKEN', value: 'tok_12345678' },
      { name: 'UNUSED', value: 'never_seen_9' },
    ]);
    const out = redactor.redact(
      "if (env.MODE === 'production' && flag === 'true') send('tok_12345678', 'tok_12345678');",
    );
    expect(out).toBe(
      "if (env.MODE === 'production' && flag === 'true') send('[REDACTED:TOKEN]', '[REDACTED:TOKEN]');",
    );
    expect(redactor.hits()).toBe(1);
  });

  it('replaces a longer value whole when it contains a shorter one', () => {
    const redactor = createSecurityRedactor([
      { name: 'SHORT', value: 'abc12345' },
      { name: 'LONG', value: 'abc12345-extra-XYZ' },
    ]);
    expect(redactor.redact('k=abc12345-extra-XYZ; j=abc12345')).toBe(
      'k=[REDACTED:LONG]; j=[REDACTED:SHORT]',
    );
  });
});
