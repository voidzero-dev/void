import { describe, it, expect } from 'vite-plus/test';
import { resolveStaticPath, getContentType } from '../../src/static.ts';
import type { AssetConfig } from '../../src/static.ts';

const manifest: Record<string, string> = {
  '/index.html': 'hash_index',
  '/about.html': 'hash_about',
  '/about/index.html': 'hash_about_index',
  '/blog/post.html': 'hash_post',
  '/blog/index.html': 'hash_blog_index',
  '/assets/style.css': 'hash_css',
  '/404.html': 'hash_404',
};

describe('resolveStaticPath', () => {
  describe('exact match', () => {
    it('returns exact match for any html_handling mode', () => {
      const config: AssetConfig = { html_handling: 'none' };
      expect(resolveStaticPath('/assets/style.css', manifest, config)).toEqual({
        path: '/assets/style.css',
        hash: 'hash_css',
      });
    });
  });

  describe('html_handling: auto-trailing-slash (default)', () => {
    const config: AssetConfig = {};

    it('resolves /blog to /blog/index.html when no .html exists', () => {
      const m = { '/blog/index.html': 'hash_blog_index' };
      expect(resolveStaticPath('/blog', m, config)).toEqual({
        path: '/blog/index.html',
        hash: 'hash_blog_index',
      });
    });

    it('resolves / to /index.html', () => {
      expect(resolveStaticPath('/', manifest, config)).toEqual({
        path: '/index.html',
        hash: 'hash_index',
      });
    });

    it('prefers .html over /index.html when both exist', () => {
      expect(resolveStaticPath('/about', manifest, config)).toEqual({
        path: '/about.html',
        hash: 'hash_about',
      });
    });
  });

  describe('html_handling: force-trailing-slash', () => {
    const config: AssetConfig = { html_handling: 'force-trailing-slash' };

    it('redirects /about to /about/ when /about/index.html exists', () => {
      expect(resolveStaticPath('/about', manifest, config)).toEqual({
        path: '/about/index.html',
        hash: 'hash_about_index',
        redirect: '/about/',
      });
    });

    it('serves /about/ directly from /about/index.html', () => {
      expect(resolveStaticPath('/about/', manifest, config)).toEqual({
        path: '/about/index.html',
        hash: 'hash_about_index',
      });
    });

    it('serves / from /index.html (no redirect for root)', () => {
      expect(resolveStaticPath('/', manifest, config)).toEqual({
        path: '/index.html',
        hash: 'hash_index',
      });
    });
  });

  describe('html_handling: drop-trailing-slash', () => {
    const config: AssetConfig = { html_handling: 'drop-trailing-slash' };

    it('redirects /about/ to /about when /about.html exists', () => {
      expect(resolveStaticPath('/about/', manifest, config)).toEqual({
        path: '/about.html',
        hash: 'hash_about',
        redirect: '/about',
      });
    });

    it('serves /about directly from /about.html', () => {
      expect(resolveStaticPath('/about', manifest, config)).toEqual({
        path: '/about.html',
        hash: 'hash_about',
      });
    });

    it('serves / from /index.html (no redirect for root)', () => {
      expect(resolveStaticPath('/', manifest, config)).toEqual({
        path: '/index.html',
        hash: 'hash_index',
      });
    });
  });

  describe('html_handling: none', () => {
    const config: AssetConfig = { html_handling: 'none' };

    it('returns null for /about (no exact match)', () => {
      const m = { '/about.html': 'hash' };
      expect(resolveStaticPath('/about', m, config)).toBeNull();
    });

    it('returns exact match for /about.html', () => {
      expect(resolveStaticPath('/about.html', manifest, config)).toEqual({
        path: '/about.html',
        hash: 'hash_about',
      });
    });
  });

  describe('not_found_handling: single-page-application', () => {
    const config: AssetConfig = {
      html_handling: 'none',
      not_found_handling: 'single-page-application',
    };

    it('falls back to /index.html for unknown paths', () => {
      expect(resolveStaticPath('/unknown/path', manifest, config)).toEqual({
        path: '/index.html',
        hash: 'hash_index',
        spa: true,
      });
    });
  });

  describe('not_found_handling: 404-page', () => {
    const config: AssetConfig = {
      html_handling: 'none',
      not_found_handling: '404-page',
    };

    it('falls back to /404.html for unknown paths', () => {
      expect(resolveStaticPath('/unknown', manifest, config)).toEqual({
        path: '/404.html',
        hash: 'hash_404',
        notFound: true,
      });
    });

    it('returns null when /404.html does not exist', () => {
      const m = { '/index.html': 'hash' };
      expect(resolveStaticPath('/unknown', m, config)).toBeNull();
    });
  });

  describe('not_found_handling: none', () => {
    const config: AssetConfig = {
      html_handling: 'none',
      not_found_handling: 'none',
    };

    it('returns null for unknown paths', () => {
      expect(resolveStaticPath('/unknown', manifest, config)).toBeNull();
    });
  });

  describe('percent-encoded request paths', () => {
    // Manifest keys are the asset's decoded on-disk path, but `url.pathname`
    // arrives percent-encoded (WHATWG URL never decodes it). A filename with a
    // space is stored as a literal space yet requested as `%20`, so the raw
    // lookup misses. Regression: the oxc.rs hero `.riv` (a file literally named
    // `640_x_630_oxc masthead_.B7dLtkJB.riv`) 404'd because `%20` != ' '.
    const m: Record<string, string> = {
      '/assets/640_x_630_oxc masthead_.B7dLtkJB.riv': 'hash_riv',
      '/files/a#b.txt': 'hash_hash',
    };

    it('resolves a %20-encoded request to a literal-space manifest key', () => {
      expect(
        resolveStaticPath('/assets/640_x_630_oxc%20masthead_.B7dLtkJB.riv', m, {
          html_handling: 'none',
        }),
      ).toEqual({ path: '/assets/640_x_630_oxc masthead_.B7dLtkJB.riv', hash: 'hash_riv' });
    });

    it('resolves other percent-encoded characters (e.g. %23 for #)', () => {
      expect(resolveStaticPath('/files/a%23b.txt', m, { html_handling: 'none' })).toEqual({
        path: '/files/a#b.txt',
        hash: 'hash_hash',
      });
    });

    it.each(['[...slug]', '%5B...slug%5D', '%5b...slug%5d', '[...slug%5D', '%5B...slug]'])(
      'resolves a Next.js chunk with square brackets requested as %s before the SPA fallback',
      (filename) => {
        const path = '/_next/static/chunks/pages/package/[...slug]-abc123.js';
        expect(
          resolveStaticPath(
            `/_next/static/chunks/pages/package/${filename}-abc123.js`,
            { [path]: 'hash_chunk', '/index.html': 'hash_index' },
            { html_handling: 'none', not_found_handling: 'single-page-application' },
          ),
        ).toEqual({ path, hash: 'hash_chunk' });
      },
    );

    it('resolves encoded brackets with spaces and UTF-8 in directory and file names', () => {
      const path = '/files/[café docs]/[[...slug]].js';
      expect(
        resolveStaticPath(
          '/files/%5Bcaf%C3%A9%20docs%5D/%5B%5B...slug%5D%5D.js',
          { [path]: 'hash_chunk' },
          { html_handling: 'none' },
        ),
      ).toEqual({ path, hash: 'hash_chunk' });
    });

    it('prefers a literal percent-encoded bracket filename over the decoded key', () => {
      const path = '/files/%5Bslug%5D.js';
      expect(
        resolveStaticPath(
          path,
          { [path]: 'raw_hit', '/files/[slug].js': 'decoded_hit' },
          { html_handling: 'none' },
        ),
      ).toEqual({ path, hash: 'raw_hit' });
    });

    it.each([
      '/assets%2F%5Bslug%5D.js',
      '/%61ssets/%5Bslug%5D.js',
      '/%5F%5Fvoid/%5Bslug%5D.js',
      '/assets/%2e%2e/%5Bslug%5D.js',
      '/assets/%255Bslug%255D.js',
      '/assets/%5Bslug%5D%2.js',
    ])('does not relax other encoding guards for bracketed paths: %s', (path) => {
      const guarded = {
        '/assets/[slug].js': 'hash_asset',
        '/__void/[slug].js': 'hash_internal',
        '/assets/../[slug].js': 'hash_dot',
        '/assets/%5Bslug%5D.js': 'hash_percent',
        '/assets/[slug]%2.js': 'hash_malformed',
      };
      expect(resolveStaticPath(path, guarded, { html_handling: 'none' })).toBeNull();
    });

    it('still prefers an exact raw match over the decoded key', () => {
      // A file whose name literally contains "%20" must win on the raw path.
      const literal: Record<string, string> = {
        '/x%20y.txt': 'raw_hit',
        '/x y.txt': 'decoded_hit',
      };
      expect(resolveStaticPath('/x%20y.txt', literal, { html_handling: 'none' })).toEqual({
        path: '/x%20y.txt',
        hash: 'raw_hit',
      });
    });

    it('does not throw on a malformed percent-sequence, just misses', () => {
      expect(resolveStaticPath('/bad%2', m, { html_handling: 'none' })).toBeNull();
    });

    it('rejects encoded separators, ordinary path text, and dot segments', () => {
      // Apart from square brackets, the decoded fallback only accepts encodings
      // a URL requires (space, #, UTF-8, …). An over-encoded spelling of
      // ordinary path text — %2F for '/', %61 for 'a', %5F for '_', %2e%2e for
      // '..' — must be rejected: otherwise a request could reconstruct a guarded
      // path (`/assets%2Fapp.js`, `/%61ssets/app.js`, `/%5F%5Fvoid/secret.js`)
      // and serve the manifest entry while the raw-`url.pathname` policy gates
      // — the `/__void/*` reserved-route block, the hashed-asset prefix gate,
      // and the header/redirect rules — never fire.
      const guarded: Record<string, string> = {
        '/assets/app.js': 'hash_app',
        '/__void/secret.js': 'hash_secret',
      };
      const cfg = { html_handling: 'none' } as const;
      // encoded slash (both cases)
      expect(resolveStaticPath('/assets%2Fapp.js', guarded, cfg)).toBeNull();
      expect(resolveStaticPath('/assets%2fapp.js', guarded, cfg)).toBeNull();
      expect(resolveStaticPath('/__void%2Fsecret.js', guarded, cfg)).toBeNull();
      // over-encoded ordinary characters
      expect(resolveStaticPath('/%61ssets/app.js', guarded, cfg)).toBeNull();
      expect(resolveStaticPath('/%5F%5Fvoid/secret.js', guarded, cfg)).toBeNull();
      // reconstructed dot-segments
      expect(resolveStaticPath('/assets/%2e%2e/app.js', guarded, cfg)).toBeNull();
    });

    it('resolves a UTF-8 (non-ASCII) filename requested percent-encoded', () => {
      const m: Record<string, string> = { '/assets/café.png': 'hash_cafe' };
      // "café" → the é is C3 A9 in UTF-8
      expect(resolveStaticPath('/assets/caf%C3%A9.png', m, { html_handling: 'none' })).toEqual({
        path: '/assets/café.png',
        hash: 'hash_cafe',
      });
    });

    it('accepts lower-case percent escapes (browsers emit upper, but both are valid)', () => {
      const m: Record<string, string> = { '/assets/café.png': 'hash_cafe' };
      expect(resolveStaticPath('/assets/caf%c3%a9.png', m, { html_handling: 'none' })).toEqual({
        path: '/assets/café.png',
        hash: 'hash_cafe',
      });
    });

    it('re-encodes a redirect Location produced from a decoded match', () => {
      // force-trailing-slash: `/docs/a#b` (requested `%23`) is backed by
      // `/docs/a#b/index.html`, so it redirects to the trailing-slash form. The
      // Location must be URL-safe (`/docs/a%23b/`), not the decoded `/docs/a#b/`
      // — otherwise the browser reads `#b/` as a fragment.
      const m: Record<string, string> = { '/docs/a#b/index.html': 'hash_idx' };
      expect(
        resolveStaticPath('/docs/a%23b', m, { html_handling: 'force-trailing-slash' }),
      ).toEqual({ path: '/docs/a#b/index.html', hash: 'hash_idx', redirect: '/docs/a%23b/' });
    });

    it('does not support a literal % in a filename (known limitation, not a regression)', () => {
      // A file literally named `logo%20.svg` is requested as `logo%2520.svg`.
      // decodeURIComponent yields the key, but re-encoding can't reproduce the
      // double-escaped request (the URL path encoder leaves `%` alone), so it
      // misses — same as before this change. Locked here so the behavior is
      // intentional, not an accidental regression.
      const m: Record<string, string> = { '/assets/logo%20.svg': 'hash_logo' };
      expect(resolveStaticPath('/assets/logo%2520.svg', m, { html_handling: 'none' })).toBeNull();
    });
  });
});

describe('getContentType', () => {
  it('returns text/html for .html files', () => {
    expect(getContentType('/index.html')).toBe('text/html; charset=utf-8');
  });

  it('returns text/css for .css files', () => {
    expect(getContentType('/assets/style.css')).toBe('text/css; charset=utf-8');
  });

  it('returns text/javascript for .js files', () => {
    expect(getContentType('/app.js')).toBe('text/javascript; charset=utf-8');
  });

  it('returns application/json for .json files', () => {
    expect(getContentType('/data.json')).toBe('application/json; charset=utf-8');
  });

  it('returns image/png for .png files', () => {
    expect(getContentType('/logo.png')).toBe('image/png');
  });

  it('returns application/wasm for .wasm files', () => {
    expect(getContentType('/module.wasm')).toBe('application/wasm');
  });

  it('returns text/markdown for .md files', () => {
    expect(getContentType('/guide/github-actions-cache.md')).toBe('text/markdown; charset=utf-8');
  });

  it('returns text/markdown for .markdown files', () => {
    expect(getContentType('/notes.markdown')).toBe('text/markdown; charset=utf-8');
  });

  it('returns text/yaml for .yaml and .yml files', () => {
    expect(getContentType('/config.yaml')).toBe('text/yaml; charset=utf-8');
    expect(getContentType('/config.yml')).toBe('text/yaml; charset=utf-8');
  });

  it('returns application/toml for .toml files', () => {
    expect(getContentType('/config.toml')).toBe('application/toml');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(getContentType('/file.xyz')).toBe('application/octet-stream');
  });

  it('returns application/octet-stream for files with no extension', () => {
    expect(getContentType('/LICENSE')).toBe('application/octet-stream');
  });
});
