// @vitest-environment happy-dom

import { jsx } from 'hono/jsx';
import type { Child } from 'hono/jsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { parseCacheFor } from 'void/pages-prefetch';
import { startHonoPages, type HonoPagesConfig } from '../../src/runtime/pages-client.tsx';
import { useNavigation } from '../../src/runtime/use-navigation.ts';

type PageData = { component: string; props: Record<string, unknown>; url: string };

function page(id: string): () => Promise<{ default: () => unknown }> {
  return async () => ({ default: () => jsx('h1', {}, id) });
}

function pageJson(body: PageData): Response {
  return Response.json(body, { headers: { 'X-VoidPages': 'true' } });
}

/** Shows the navigation state, as a progress indicator in a layout would. */
async function layout(): Promise<{ default: (props: { children?: Child }) => unknown }> {
  return {
    default: ({ children }) =>
      jsx('div', { id: 'layout', 'data-state': useNavigation().state }, children),
  };
}

function config(components: HonoPagesConfig['components']): HonoPagesConfig {
  return {
    components: { ...components, layout },
    layoutTree: Object.fromEntries(Object.keys(components).map((id) => [id, ['layout']])),
    routeMeta: {},
    matchRoute: (path) => (path === '/' ? 'home' : path.slice(1)),
    viewTransitions: false,
    prefetchHoverDelay: 75,
    prefetchDefaultCacheFor: parseCacheFor('30s'),
  };
}

function heading(): string | null | undefined {
  return document.querySelector('#app h1')?.textContent;
}

beforeEach(() => {
  const home: PageData = { component: 'home', props: {}, url: '/' };
  document.body.innerHTML = `
    <script id="__VOID_PAGE_DATA__" type="application/json">${JSON.stringify(home)}</script>
    <div id="app"><h1>home</h1></div>`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      return pageJson({ component: url.pathname.slice(1), props: {}, url: url.pathname });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('startHonoPages', () => {
  it('renders the initial page and marks the app hydrated', async () => {
    await startHonoPages(config({ home: page('home') }));

    expect(heading()).toBe('home');
    expect(document.getElementById('app')?.getAttribute('data-hydrated')).toBe('true');
  });

  it('settles a visit once its page is in the DOM', async () => {
    const { router } = await startHonoPages(config({ home: page('home'), a: page('a') }));

    await router.visit('/a');

    expect(heading()).toBe('a');
  });

  it('ends on the newer page when two visits start back to back', async () => {
    const { router } = await startHonoPages(
      config({ home: page('home'), a: page('a'), b: page('b') }),
    );
    await Promise.all([router.prefetch('/a'), router.prefetch('/b')]);

    const first = router.visit('/a');
    const second = router.visit('/b');
    const settled = await Promise.race([
      Promise.allSettled([first, second]).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);

    expect(settled).toBe(true);
    expect(heading()).toBe('b');
  });

  it('fails a visit to a page that throws while rendering and keeps the current page', async () => {
    const { router } = await startHonoPages(
      config({
        home: page('home'),
        broken: async () => ({
          default: () => {
            throw new Error('render failed');
          },
        }),
        a: page('a'),
      }),
    );

    const settled = await Promise.race([
      router.visit('/broken').then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 500)),
    ]);

    expect(settled).toBe('render failed');
    expect(heading()).toBe('home');
    await vi.waitFor(() => {
      expect(document.getElementById('layout')?.getAttribute('data-state')).toBe('idle');
    });

    // The router keeps working afterwards.
    await router.visit('/a');
    expect(heading()).toBe('a');
  });
});
