import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneWithoutVoidPages } from '@void/isr/runtime';
import { describe, expect, it } from 'vite-plus/test';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import { extractCssImports } from '../../src/pages/islands-plugin.ts';

// Published helpers remain compatible until the next major release.
const HOST = 'app.void.app';

describe('cloneWithoutVoidPages', () => {
  it('removes Pages protocol headers while preserving method, url, and other headers', () => {
    const original = new Request(`https://${HOST}/blog/post`, {
      method: 'GET',
      headers: {
        'X-VoidPages': 'true',
        'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
        'X-Test-Marker': 'keep',
        Accept: 'text/html',
      },
    });

    const cleaned = cloneWithoutVoidPages(original);

    expect(cleaned.headers.has('X-VoidPages')).toBe(false);
    expect(cleaned.headers.has('X-VoidPages-Version')).toBe(false);
    expect(cleaned.headers.get('X-Test-Marker')).toBe('keep');
    expect(cleaned.headers.get('Accept')).toBe('text/html');
    expect(cleaned.method).toBe('GET');
    expect(cleaned.url).toBe(`https://${HOST}/blog/post`);
  });
});

it('keeps the deprecated CSS import helper compatible', () => {
  const root = mkdtempSync(join(tmpdir(), 'void-compat-css-'));
  try {
    const path = join(root, 'page.tsx');
    writeFileSync(path, "import './real.css';");
    expect(extractCssImports(path)).toBe('@import "./real.css";');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
