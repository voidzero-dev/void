import { expect, it } from 'vite-plus/test';
import { createSecurityRedactor, secretForms } from '../../src/security/input/redact.ts';

const secret = { name: 'STRIPE_KEY', value: 'sk_live_a/b+c"d=1' };

it('replaces a stored secret in every form, longest first, and leaves plain values alone', () => {
  const redactor = createSecurityRedactor([
    secret,
    { name: 'MODE', value: 'production' },
    { name: 'SHORT', value: 'abc12345' },
    { name: 'LONG', value: 'abc12345-extra-XYZ' },
  ]);
  const text = [
    `const raw = '${secret.value}';`,
    `const json = "${JSON.stringify(secret.value).slice(1, -1)}";`,
    `const b64 = '${btoa(secret.value)}';`,
    `fetch('/x?key=${encodeURIComponent(secret.value)}');`,
    "if (env.MODE === 'production') k = 'abc12345-extra-XYZ', j = 'abc12345';",
  ].join('\n');
  const out = redactor.redact(text);
  for (const form of secretForms(secret.value)) {
    expect(out).not.toContain(form);
  }
  expect(out).toContain('[REDACTED:STRIPE_KEY]');
  expect(out).toContain("'production') k = '[REDACTED:LONG]', j = '[REDACTED:SHORT]'");
});

it('names each secret hit with its forms and first line, never the value', () => {
  const redactor = createSecurityRedactor([secret, { name: 'UNUSED', value: 'never_seen_9' }]);
  const text = [
    'const a = 1;',
    `const b64 = '${btoa(secret.value)}';`,
    `const raw = '${secret.value}';`,
    `fetch('/x?key=${encodeURIComponent(secret.value)}');`,
  ].join('\n');
  const hits = redactor.hitsIn(text);
  expect(hits).toEqual([{ name: 'STRIPE_KEY', forms: ['raw', 'base64', 'url'], line: 2 }]);
  expect(JSON.stringify(hits)).not.toContain(secret.value);
});
