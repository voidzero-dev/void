// Every `vp dev`/`vp build` imports the plugin entry first, so auth codegen and CLI output
// must not load at startup.
import { expect, it, vi } from 'vite-plus/test';

const loaded = vi.hoisted((): Array<string> => []);

vi.mock('../../src/auth/drizzle.ts', () => {
  loaded.push('src/auth/drizzle.ts');
  return {};
});
vi.mock('../../src/cli/output.ts', () => {
  loaded.push('src/cli/output.ts');
  return {};
});
vi.mock('better-auth/db', () => {
  loaded.push('better-auth/db');
  return {};
});
vi.mock('terminal-link', () => {
  loaded.push('terminal-link');
  return {};
});

it('keeps auth codegen and CLI output out of the plugin entry', async () => {
  // The first import of the whole plugin entry takes a few seconds.
  await import('../../src/index.ts');
  expect(loaded).toEqual([]);
}, 30_000);
