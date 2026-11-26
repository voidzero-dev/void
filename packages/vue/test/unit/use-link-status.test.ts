import { expect, it } from 'vite-plus/test';
import { createSsrRouter } from 'void/pages-client';
import type { LinkActiveMatch, LinkStatus, NavigationState } from 'void/pages-client';
import { createSSRApp, reactive, ref, watch } from 'vue';
import { useLinkStatus } from '../../src/runtime/use-link-status.ts';

it('tracks a destination ref and options supplied by a getter', () => {
  const app = createSSRApp({});
  app.provide('__void_router', createSsrRouter('/posts/first'));
  const href = ref('/posts/first');
  const activeMatch = ref<LinkActiveMatch>('exact');
  const status = app.runWithContext(() =>
    useLinkStatus(href, () => ({ activeMatch: activeMatch.value })),
  );
  expect(status.value).toEqual({ active: true, current: true, pending: false });
  href.value = '/posts';
  expect(status.value.active).toBe(false);
  activeMatch.value = 'prefix';
  expect(status.value).toEqual({ active: true, current: false, pending: false });
});

it('notifies watchers only when the status changes', () => {
  const app = createSSRApp({});
  const router = createSsrRouter('/posts/first');
  const navigation = reactive<NavigationState>({ state: 'idle', location: null, method: null });
  app.provide('__void_router', router);
  app.provide('__void_navigation', navigation);
  const href = ref('/about');
  const status = app.runWithContext(() => useLinkStatus(href));
  const seen: Array<LinkStatus> = [];
  watch(status, (value) => seen.push(value), { flush: 'sync' });

  const initial = status.value;
  href.value = '/contact';
  Object.assign(navigation, {
    state: 'loading',
    location: new URL('/posts', router.url),
    method: 'GET',
  });
  expect(status.value).toBe(initial);
  expect(seen).toEqual([]);

  navigation.location = new URL('/contact', router.url);
  expect(seen).toEqual([{ current: false, active: false, pending: true }]);
});
