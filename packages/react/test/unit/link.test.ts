import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';
import { createSsrRouter } from 'void/pages-client';
import { RouterContext } from '../../src/runtime/context.ts';
import { Link, type LinkProps } from '../../src/runtime/link.tsx';

function renderAt(url: string | null, props: LinkProps): string {
  return renderToStaticMarkup(
    createElement(
      RouterContext.Provider,
      { value: url === null ? null : createSsrRouter(url) },
      createElement(Link, props, 'Users'),
    ),
  );
}

describe('Link', () => {
  it('marks the link to the current page', () => {
    const current = renderAt('/users', { href: '/users' });
    expect(current).toContain('aria-current="page"');
    expect(current).toContain('data-void-active=""');

    const nested = renderAt('/users/1', { href: '/users', activeMatch: 'prefix' });
    expect(nested).not.toContain('aria-current');
    expect(nested).toContain('data-void-active=""');

    expect(renderAt('/users/1', { href: '/users' })).not.toContain('data-void-active');
    expect(renderAt(null, { href: '/users' })).not.toContain('data-void-active');
  });

  it('lets passed attributes override the active state', () => {
    const markup = renderAt('/checkout', { href: '/checkout', 'aria-current': 'step' });
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain('data-void-active=""');
  });

  it('preserves dot-segment relative hrefs when merging GET data', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Link,
        {
          href: '../users?sort=name#team',
          data: {
            page: 2,
          },
        },
        'Users',
      ),
    );

    expect(markup).toContain('href="../users?sort=name&amp;page=2#team"');
  });

  it('preserves hrefs when GET data does not add query params', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Link,
        {
          href: '../users',
          data: {
            empty: [],
            skip: null,
            missing: undefined,
          },
        },
        'Users',
      ),
    );

    expect(markup).toContain('href="../users"');
  });

  it('rejects nested GET data', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Link, { href: '/users', data: { filters: { status: 'open' } } }, 'Users'),
      ),
    ).toThrow('Link: GET data only supports primitive values and arrays');
  });

  it('rejects prefetch on non-GET links', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Link, { href: '/users', method: 'POST', prefetch: true }, 'Create'),
      ),
    ).toThrow('Link: prefetch only supports GET links');
  });

  it('rejects reloadDocument on non-GET links', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(Link, { href: '/users', method: 'POST', reloadDocument: true }, 'Create'),
      ),
    ).toThrow('Link: reloadDocument only supports GET links');
  });
});
