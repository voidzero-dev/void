import { describe, expect, it } from 'vite-plus/test';
import {
  resolveHead,
  renderHeadToString,
  renderHtmlAttrs,
  renderBodyAttrs,
  type HeadConfig,
  type HeadDescriptor,
} from '../../src/pages/head.ts';

describe('resolveHead', () => {
  it('returns undefined when all inputs are undefined', () => {
    expect(resolveHead(undefined, undefined, undefined)).toBeUndefined();
  });

  it('returns config head when it is the only layer', () => {
    const config: HeadConfig = { title: 'My Site' };
    expect(resolveHead(config, undefined, undefined)).toEqual({ title: 'My Site' });
  });

  it('page title wins over middleware and config', () => {
    const config: HeadConfig = { title: 'Config' };
    const middleware: HeadDescriptor = { title: 'Middleware' };
    const page: HeadDescriptor = { title: 'Page' };
    expect(resolveHead(config, middleware, page)?.title).toBe('Page');
  });

  it('middleware title wins over config when no page title', () => {
    const config: HeadConfig = { title: 'Config' };
    const middleware: HeadDescriptor = { title: 'Middleware' };
    expect(resolveHead(config, middleware, undefined)?.title).toBe('Middleware');
  });

  it('applies titleTemplate from config', () => {
    const config: HeadConfig = { titleTemplate: '%s | My Site' };
    const page: HeadDescriptor = { title: 'About' };
    expect(resolveHead(config, undefined, page)?.title).toBe('About | My Site');
  });

  it('applies titleTemplate to middleware title too', () => {
    const config: HeadConfig = { titleTemplate: '%s | My Site' };
    const middleware: HeadDescriptor = { title: 'Dashboard' };
    expect(resolveHead(config, middleware, undefined)?.title).toBe('Dashboard | My Site');
  });

  it('middleware titleTemplate wins over config', () => {
    const config: HeadConfig = { titleTemplate: '%s | My Site' };
    const middleware: HeadConfig = { titleTemplate: '%s | Admin' };
    const page: HeadDescriptor = { title: 'Users' };
    expect(resolveHead(config, middleware, page)?.title).toBe('Users | Admin');
  });

  it('applies middleware titleTemplate without a config template', () => {
    const middleware: HeadConfig = { titleTemplate: '%s | Admin' };
    const page: HeadDescriptor = { title: 'Users' };
    expect(resolveHead(undefined, middleware, page)?.title).toBe('Users | Admin');
  });

  it('falls back to config titleTemplate when middleware sets none', () => {
    const config: HeadConfig = { titleTemplate: '%s | My Site' };
    const middleware: HeadConfig = { meta: [{ name: 'robots', content: 'noindex' }] };
    const page: HeadDescriptor = { title: 'Users' };
    expect(resolveHead(config, middleware, page)?.title).toBe('Users | My Site');
  });

  it('does not emit titleTemplate in the resolved head', () => {
    const middleware: HeadConfig = { titleTemplate: '%s | Admin' };
    const page: HeadDescriptor = { title: 'Users' };
    expect(resolveHead(undefined, middleware, page)).toEqual({ title: 'Users | Admin' });
  });

  it('deduplicates meta by name — page wins', () => {
    const config: HeadConfig = {
      meta: [{ name: 'description', content: 'Config desc' }],
    };
    const page: HeadDescriptor = {
      meta: [{ name: 'description', content: 'Page desc' }],
    };
    const result = resolveHead(config, undefined, page);
    expect(result?.meta).toEqual([{ name: 'description', content: 'Page desc' }]);
  });

  it('deduplicates meta by property — page wins', () => {
    const config: HeadConfig = {
      meta: [{ property: 'og:title', content: 'Config OG' }],
    };
    const page: HeadDescriptor = {
      meta: [{ property: 'og:title', content: 'Page OG' }],
    };
    const result = resolveHead(config, undefined, page);
    expect(result?.meta).toEqual([{ property: 'og:title', content: 'Page OG' }]);
  });

  it('appends non-conflicting meta entries', () => {
    const config: HeadConfig = {
      meta: [{ charset: 'utf-8' }],
    };
    const page: HeadDescriptor = {
      meta: [{ name: 'description', content: 'Hello' }],
    };
    const result = resolveHead(config, undefined, page);
    expect(result?.meta).toHaveLength(2);
    expect(result?.meta![0]).toEqual({ charset: 'utf-8' });
    expect(result?.meta![1]).toEqual({ name: 'description', content: 'Hello' });
  });

  it('concatenates link entries across layers', () => {
    const config: HeadConfig = {
      link: [{ rel: 'icon', href: '/favicon.ico' }],
    };
    const page: HeadDescriptor = {
      link: [{ rel: 'canonical', href: 'https://example.com' }],
    };
    const result = resolveHead(config, undefined, page);
    expect(result?.link).toHaveLength(2);
    expect(result?.link![0].rel).toBe('icon');
    expect(result?.link![1].rel).toBe('canonical');
  });

  it('concatenates script entries across layers', () => {
    const config: HeadConfig = {
      script: [{ src: '/analytics.js' }],
    };
    const middleware: HeadDescriptor = {
      script: [{ innerHTML: "console.log('hi')" }],
    };
    const result = resolveHead(config, middleware, undefined);
    expect(result?.script).toHaveLength(2);
    expect(result?.script![0].src).toBe('/analytics.js');
    expect(result?.script![1].innerHTML).toBe("console.log('hi')");
  });

  it('shallow-merges htmlAttrs — page wins conflicts', () => {
    const config: HeadConfig = { htmlAttrs: { lang: 'en', dir: 'ltr' } };
    const page: HeadDescriptor = { htmlAttrs: { lang: 'fr' } };
    const result = resolveHead(config, undefined, page);
    expect(result?.htmlAttrs).toEqual({ lang: 'fr', dir: 'ltr' });
  });

  it('shallow-merges bodyAttrs — page wins conflicts', () => {
    const config: HeadConfig = { bodyAttrs: { class: 'light' } };
    const page: HeadDescriptor = { bodyAttrs: { class: 'dark' } };
    const result = resolveHead(config, undefined, page);
    expect(result?.bodyAttrs).toEqual({ class: 'dark' });
  });

  it('returns undefined when layers are defined but empty', () => {
    expect(resolveHead({}, {}, {})).toBeUndefined();
  });
});

describe('renderHeadToString', () => {
  it('renders title', () => {
    expect(renderHeadToString({ title: 'Hello' })).toBe('<title>Hello</title>');
  });

  it('escapes HTML in title', () => {
    expect(renderHeadToString({ title: '<script>alert("xss")</script>' })).toBe(
      '<title>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</title>',
    );
  });

  it('renders meta tags', () => {
    const html = renderHeadToString({
      meta: [
        { charset: 'utf-8' },
        { name: 'description', content: 'A page' },
        { property: 'og:title', content: 'Title' },
      ],
    });
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="description" content="A page">');
    expect(html).toContain('<meta property="og:title" content="Title">');
  });

  it('renders link tags', () => {
    const html = renderHeadToString({
      link: [{ rel: 'stylesheet', href: '/style.css' }],
    });
    expect(html).toBe('<link rel="stylesheet" href="/style.css">');
  });

  it('renders script with src', () => {
    const html = renderHeadToString({
      script: [{ src: '/app.js', defer: 'defer' }],
    });
    expect(html).toBe('<script src="/app.js" defer="defer"></script>');
  });

  it('renders inline script', () => {
    const html = renderHeadToString({
      script: [{ innerHTML: "console.log('hello')" }],
    });
    expect(html).toBe("<script>console.log('hello')</script>");
  });

  it('renders combined head', () => {
    const html = renderHeadToString({
      title: 'Test',
      meta: [{ name: 'viewport', content: 'width=device-width' }],
    });
    expect(html).toContain('<title>Test</title>');
    expect(html).toContain('<meta name="viewport" content="width=device-width">');
  });

  it('returns empty string for empty descriptor', () => {
    expect(renderHeadToString({})).toBe('');
  });
});

describe('renderHtmlAttrs', () => {
  it('returns empty string when no htmlAttrs', () => {
    expect(renderHtmlAttrs({})).toBe('');
  });

  it('returns attribute string with leading space', () => {
    expect(renderHtmlAttrs({ htmlAttrs: { lang: 'en' } })).toBe(' lang="en"');
  });

  it('renders multiple attributes', () => {
    const result = renderHtmlAttrs({ htmlAttrs: { lang: 'en', dir: 'ltr' } });
    expect(result).toContain('lang="en"');
    expect(result).toContain('dir="ltr"');
    expect(result).toMatch(/^ /); // leading space
  });

  it('escapes attribute values', () => {
    expect(renderHtmlAttrs({ htmlAttrs: { 'data-x': '"quoted"' } })).toBe(
      ' data-x="&quot;quoted&quot;"',
    );
  });
});

describe('renderBodyAttrs', () => {
  it('returns empty string when no bodyAttrs', () => {
    expect(renderBodyAttrs({})).toBe('');
  });

  it('returns attribute string with leading space', () => {
    expect(renderBodyAttrs({ bodyAttrs: { class: 'dark' } })).toBe(' class="dark"');
  });
});
