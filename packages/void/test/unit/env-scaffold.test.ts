import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import {
  collectInferredEntries,
  inferHelperForValue,
  maybeScaffoldEnvTs,
  renderEnvTs,
} from '../../src/cli/env-scaffold.ts';

describe('inferHelperForValue', () => {
  it('returns string for empty or missing values', () => {
    expect(inferHelperForValue(undefined)).toBe('string');
    expect(inferHelperForValue('')).toBe('string');
    expect(inferHelperForValue('   ')).toBe('string');
  });

  it('detects boolean literals case-insensitively', () => {
    expect(inferHelperForValue('true')).toBe('boolean');
    expect(inferHelperForValue('false')).toBe('boolean');
    expect(inferHelperForValue('TRUE')).toBe('boolean');
    expect(inferHelperForValue('False')).toBe('boolean');
  });

  it('detects http/https URLs', () => {
    expect(inferHelperForValue('http://localhost:3000')).toBe('url');
    expect(inferHelperForValue('https://api.example.com/v1')).toBe('url');
  });

  it('does not detect non-http schemes as url', () => {
    expect(inferHelperForValue('postgres://u:p@host/db')).toBe('string');
    expect(inferHelperForValue('ws://localhost:3000')).toBe('string');
  });

  it('detects small integers as number', () => {
    expect(inferHelperForValue('0')).toBe('number');
    expect(inferHelperForValue('3000')).toBe('number');
    expect(inferHelperForValue('65535')).toBe('number');
  });

  it('refuses suspicious numeric strings', () => {
    // Leading zero suggests a code, not a number.
    expect(inferHelperForValue('0123')).toBe('string');
    // Too long to be a meaningful port/size — likely an ID or phone number.
    expect(inferHelperForValue('123456')).toBe('string');
    expect(inferHelperForValue('-5')).toBe('string');
  });

  it('falls back to string for anything non-trivially typed', () => {
    expect(inferHelperForValue('sk_live_abc123')).toBe('string');
    expect(inferHelperForValue('yes')).toBe('string');
    expect(inferHelperForValue('{"nested":true}')).toBe('string');
  });
});

describe('renderEnvTs', () => {
  it('emits an empty defineEnv for zero entries', () => {
    const out = renderEnvTs([]);
    expect(out).toContain(`import { defineEnv } from 'void/env';`);
    expect(out).toContain('export default defineEnv({});');
  });

  it('imports only the helpers it references', () => {
    const out = renderEnvTs([
      { key: 'NAME', helper: 'string' },
      { key: 'PORT', helper: 'number' },
    ]);
    const importLine = out.split('\n').find((l) => l.startsWith('import'))!;
    expect(importLine).toBe(`import { defineEnv, string, number } from 'void/env';`);
  });

  it('nudges the user to tighten inferred types', () => {
    const out = renderEnvTs([{ key: 'X', helper: 'string' }]);
    expect(out).toMatch(/tighten types/);
  });
});

describe('maybeScaffoldEnvTs', () => {
  function tmpProject(): string {
    return mkdtempSync(join(tmpdir(), 'void-env-scaffold-'));
  }

  it('is a no-op when env.ts already exists', () => {
    const root = tmpProject();
    writeFileSync(join(root, 'env.ts'), '// existing');
    writeFileSync(join(root, '.env'), 'FOO=bar\n');
    const result = maybeScaffoldEnvTs(root);
    expect(result.written).toBeNull();
    expect(result.skipReason).toBe('env-ts-exists');
    expect(readFileSync(join(root, 'env.ts'), 'utf8')).toBe('// existing');
  });

  it('is a no-op when no dotenv files are present', () => {
    const root = tmpProject();
    const result = maybeScaffoldEnvTs(root);
    expect(result.written).toBeNull();
    expect(result.skipReason).toBe('no-dotenv-files');
  });

  it('collects keys from the single .env file', () => {
    const root = tmpProject();
    writeFileSync(join(root, '.env'), 'PORT=3000\nDEBUG=true\nSTRIPE_KEY=\n');

    const entries = collectInferredEntries(root);
    expect(entries.map((e) => e.key)).toEqual(['DEBUG', 'PORT', 'STRIPE_KEY']);
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e.helper]));
    expect(byKey.PORT).toBe('number');
    expect(byKey.DEBUG).toBe('boolean');
    expect(byKey.STRIPE_KEY).toBe('string');
  });

  it('writes env.ts with the inferred schema', () => {
    const root = tmpProject();
    writeFileSync(
      join(root, '.env'),
      [
        'STRIPE_KEY=sk_live_123',
        'PORT=3000',
        'DEBUG=true',
        'WEBHOOK_URL=https://example.com/hook',
        '',
      ].join('\n'),
    );
    const result = maybeScaffoldEnvTs(root);
    expect(result.written).toBe(toSlash(join(root, 'env.ts')));
    const body = readFileSync(join(root, 'env.ts'), 'utf8');
    expect(body).toContain('STRIPE_KEY: string(),');
    expect(body).toContain('PORT: number(),');
    expect(body).toContain('DEBUG: boolean(),');
    expect(body).toContain('WEBHOOK_URL: url(),');
  });
});
