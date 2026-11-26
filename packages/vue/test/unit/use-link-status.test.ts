import { expect, it } from 'vite-plus/test';
import { createSsrRouter } from 'void/pages-client';
import type { LinkActiveMatch } from 'void/pages-client';
import { createSSRApp, ref } from 'vue';
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
