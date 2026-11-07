import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vite-plus/test';
import { createSsrRouter, type NavigationMethod, type NavigationState } from 'void/pages-client';
import { NavigationContext, RouterContext } from '../../src/runtime/context.ts';
import { Link, type LinkProps } from '../../src/runtime/link.tsx';

function render(element: { toString(): string | Promise<string> }): string {
  return String(element.toString());
}

function renderAt(url: string | null, props: LinkProps): string {
  return render(
    jsx(
      RouterContext.Provider,
      { value: url === null ? null : createSsrRouter(url) },
      jsx(Link, props, 'Users'),
    ),
  );
}

/** Renders a Link on `/` while a visit to `destination` loads. */
function renderVisiting(
  destination: string,
  props: LinkProps,
  method: NavigationMethod = 'GET',
): string {
  const navigation: NavigationState = {
    state: method === 'GET' ? 'loading' : 'submitting',
    location: new URL(destination, 'http://localhost'),
    method,
  };
  return render(
    jsx(
      RouterContext.Provider,
      { value: createSsrRouter('/') },
      jsx(NavigationContext.Provider, { value: navigation }, jsx(Link, props, 'Users')),
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

  it('marks a link while a visit to its destination loads', () => {
    expect(renderVisiting('/users', { href: '/users' })).toContain('data-void-pending=""');
    expect(renderVisiting('/users?page=2', { href: '/users' })).not.toContain('data-void-pending');
    expect(renderAt('/', { href: '/users' })).not.toContain('data-void-pending');
  });

  it('marks a non-GET link while its own method is submitting', () => {
    const markup = renderVisiting('/logout', { href: '/logout', method: 'POST' }, 'POST');
    expect(markup).toMatch(/^<button[^>]* data-void-pending=""/);
    expect(renderVisiting('/logout', { href: '/logout', method: 'POST' })).not.toContain(
      'data-void-pending',
    );
  });

  it('lets a passed data-void-pending override the pending state', () => {
    // As in JSX: <Link href="/users" data-void-pending={undefined}>
    const props = { href: '/users' as const, 'data-void-pending': undefined };
    expect(renderVisiting('/users', props)).not.toContain('data-void-pending');
  });

  it('preserves dot-segment relative hrefs when merging GET data', () => {
    const markup = render(
      jsx(
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
    const markup = render(
      jsx(
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
      render(jsx(Link, { href: '/users', data: { filters: { status: 'open' } } }, 'Users')),
    ).toThrow('Link: GET data only supports primitive values and arrays');
  });

  it('rejects prefetch on non-GET links', () => {
    expect(() =>
      render(jsx(Link, { href: '/users', method: 'POST', prefetch: true }, 'Create')),
    ).toThrow('Link: prefetch only supports GET links');
  });

  it('rejects reloadDocument on non-GET links', () => {
    expect(() =>
      render(jsx(Link, { href: '/users', method: 'POST', reloadDocument: true }, 'Create')),
    ).toThrow('Link: reloadDocument only supports GET links');
  });
});
