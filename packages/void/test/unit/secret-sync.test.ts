import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { parseDotenvFile } from '../../src/cli/secret.ts';

function writeTemp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'secret-sync-'));
  const file = join(dir, '.env');
  writeFileSync(file, content);
  return file;
}

describe('parseDotenvFile', () => {
  it('parses basic KEY=value pairs', () => {
    const file = writeTemp('API_KEY=abc123\nDB_URL=postgres://localhost');
    expect(parseDotenvFile(file)).toEqual([
      { name: 'API_KEY', value: 'abc123' },
      { name: 'DB_URL', value: 'postgres://localhost' },
    ]);
  });

  it('strips double quotes from values', () => {
    const file = writeTemp('SECRET="my secret value"');
    expect(parseDotenvFile(file)).toEqual([{ name: 'SECRET', value: 'my secret value' }]);
  });

  it('strips single quotes from values', () => {
    const file = writeTemp("SECRET='my secret value'");
    expect(parseDotenvFile(file)).toEqual([{ name: 'SECRET', value: 'my secret value' }]);
  });

  it('skips comments and blank lines', () => {
    const file = writeTemp('# This is a comment\n\nAPI_KEY=value\n  \n# Another comment\nSECRET=x');
    expect(parseDotenvFile(file)).toEqual([
      { name: 'API_KEY', value: 'value' },
      { name: 'SECRET', value: 'x' },
    ]);
  });

  it('handles values with = signs', () => {
    const file = writeTemp('BASE64=abc=def==');
    expect(parseDotenvFile(file)).toEqual([{ name: 'BASE64', value: 'abc=def==' }]);
  });

  it('handles empty values', () => {
    const file = writeTemp('EMPTY=');
    expect(parseDotenvFile(file)).toEqual([{ name: 'EMPTY', value: '' }]);
  });

  it('handles values with spaces around =', () => {
    const file = writeTemp('KEY = value');
    expect(parseDotenvFile(file)).toEqual([{ name: 'KEY', value: 'value' }]);
  });

  it('errors on lowercase key names', () => {
    const file = writeTemp('lowercase=value');
    expect(() => parseDotenvFile(file)).toThrow("secret: Invalid secret name 'lowercase'");
  });

  it('errors on keys with special characters', () => {
    const file = writeTemp('MY-KEY=value');
    expect(() => parseDotenvFile(file)).toThrow("secret: Invalid secret name 'MY-KEY'");
  });

  it('errors on keys starting with a digit', () => {
    const file = writeTemp('1KEY=value');
    expect(() => parseDotenvFile(file)).toThrow("secret: Invalid secret name '1KEY'");
  });

  it('skips lines without =, like .env loading', () => {
    const file = writeTemp('NOTAVALIDLINE\nAPI_KEY=abc');
    expect(parseDotenvFile(file)).toEqual([{ name: 'API_KEY', value: 'abc' }]);
  });

  it('drops inline comments after unquoted and quoted values', () => {
    const file = writeTemp('STRIPE_KEY=sk_live_abc # live key\nTOKEN="abc" # note\nHASH=\'a#b\'');
    expect(parseDotenvFile(file)).toEqual([
      { name: 'HASH', value: 'a#b' },
      { name: 'STRIPE_KEY', value: 'sk_live_abc' },
      { name: 'TOKEN', value: 'abc' },
    ]);
  });

  it('accepts the export prefix', () => {
    const file = writeTemp('export API_KEY=abc');
    expect(parseDotenvFile(file)).toEqual([{ name: 'API_KEY', value: 'abc' }]);
  });

  it('reads multi-line quoted values and \\n in double quotes', () => {
    const file = writeTemp(
      'PEM="-----BEGIN KEY-----\nAAAA\n-----END KEY-----"\nCERT="line1\\nline2"',
    );
    expect(parseDotenvFile(file)).toEqual([
      { name: 'CERT', value: 'line1\nline2' },
      { name: 'PEM', value: '-----BEGIN KEY-----\nAAAA\n-----END KEY-----' },
    ]);
  });

  it('keeps $VAR references literal', () => {
    const file = writeTemp('BASE=x\nPASSWORD=p$BASE${BASE}');
    expect(parseDotenvFile(file)).toEqual([
      { name: 'BASE', value: 'x' },
      { name: 'PASSWORD', value: 'p$BASE${BASE}' },
    ]);
  });

  it('ignores a UTF-8 byte order mark at the start of the file', () => {
    const file = writeTemp('﻿API_KEY=abc\nSECRET=x');
    expect(parseDotenvFile(file)).toEqual([
      { name: 'API_KEY', value: 'abc' },
      { name: 'SECRET', value: 'x' },
    ]);
  });

  it('returns empty array for empty file', () => {
    const file = writeTemp('');
    expect(parseDotenvFile(file)).toEqual([]);
  });

  it('returns empty array for comments-only file', () => {
    const file = writeTemp('# comment\n# another');
    expect(parseDotenvFile(file)).toEqual([]);
  });
});
