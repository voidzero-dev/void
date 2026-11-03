// @vitest-environment happy-dom

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Component } from 'svelte';
import { compile, compileModule } from 'svelte/compiler';
import { transformWithOxc } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { VoidRouter } from 'void/pages-client';

type TestForm = {
  readonly data: Record<string, unknown>;
  readonly errors: Record<string, string>;
  setError(field: string, message: string): void;
};

// The unit project has no Svelte plugin and resolves `svelte` to its server entry, so compile
// the rune module and a host component here and point them at Svelte's browser entries.
const TMP = join(import.meta.dirname, '.tmp-use-form');
const require = createRequire(import.meta.url);
const svelteDir = dirname(require.resolve('svelte/package.json'));
const svelteExports: Record<string, string | { browser?: string; default: string }> =
  require('svelte/package.json').exports;

function svelteBrowserUrl(specifier: string): string {
  const entry = svelteExports['.' + specifier.slice('svelte'.length)];
  const file = typeof entry === 'string' ? entry : (entry.browser ?? entry.default);
  return pathToFileURL(join(svelteDir, file)).href;
}

function writeCompiled(file: string, code: string): void {
  writeFileSync(
    join(TMP, file),
    code.replace(
      /(from |import )['"](svelte(?:\/[^'"]*)?)['"]/g,
      (_, keyword, specifier) => `${keyword}'${svelteBrowserUrl(specifier)}'`,
    ),
  );
}

let svelte: typeof import('svelte');
let Host: Component<{ defaults: Record<string, unknown>; onform: (form: TestForm) => void }>;
const mounted: Array<ReturnType<typeof import('svelte').mount>> = [];

beforeAll(async () => {
  svelte = await import(/* @vite-ignore */ svelteBrowserUrl('svelte'));
  const source = join(import.meta.dirname, '../../src/runtime/use-form.svelte.ts');
  const { code } = await transformWithOxc(readFileSync(source, 'utf8'), source);
  mkdirSync(TMP, { recursive: true });
  writeCompiled(
    'use-form.svelte.js',
    compileModule(code, { filename: source, generate: 'client' }).js.code,
  );
  const host = `<script>
  import { useForm } from './use-form.svelte.js';
  let { defaults, onform } = $props();
  onform(useForm('/notes?create', defaults));
</script>`;
  writeCompiled('Host.js', compile(host, { filename: 'Host.svelte', generate: 'client' }).js.code);
  Host = (await import(pathToFileURL(join(TMP, 'Host.js')).href)).default;
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  for (const component of mounted.splice(0)) {
    void svelte.unmount(component);
  }
});

function mountForm(defaults: Record<string, unknown>): TestForm {
  const router = { visit: async () => ({}) } as unknown as VoidRouter;
  let form!: TestForm;
  mounted.push(
    svelte.mount(Host, {
      target: document.createElement('div'),
      props: { defaults, onform: (value) => (form = value) },
      context: new Map([['__void_router', router]]),
    }),
  );
  svelte.flushSync();
  return form;
}

describe('useForm field errors', () => {
  it('keeps an error written directly in the handler that edits the field', () => {
    const form = mountForm({ email: '', name: '' });

    form.data.email = 'i';
    form.errors.email = 'Client email invalid';
    svelte.flushSync();
    expect({ ...form.errors }).toEqual({ email: 'Client email invalid' });

    // The next keystroke writes the same message again.
    form.data.email = 'in';
    form.errors.email = 'Client email invalid';
    svelte.flushSync();
    expect({ ...form.errors }).toEqual({ email: 'Client email invalid' });
  });

  it('keeps an error set with setError in the handler that edits the field', () => {
    const form = mountForm({ email: '' });

    form.data.email = 'invalid';
    form.setError('email', 'Client email invalid');
    svelte.flushSync();
    expect({ ...form.errors }).toEqual({ email: 'Client email invalid' });
  });

  it('clears only the stale error of an edited field', () => {
    const form = mountForm({ email: '', name: '', profile: { name: '' } });
    form.errors.email = 'Email invalid';
    form.errors.name = 'Name invalid';
    form.errors.profile = 'Profile invalid';
    svelte.flushSync();

    form.data.email = 'alice@example.com';
    (form.data.profile as { name: string }).name = 'Alice';
    svelte.flushSync();
    expect({ ...form.errors }).toEqual({ name: 'Name invalid' });
  });

  it('clears an error written before the field edit in the same handler', () => {
    const form = mountForm({ email: '' });

    form.errors.email = 'Email invalid';
    form.data.email = 'alice@example.com';
    svelte.flushSync();
    expect({ ...form.errors }).toEqual({});
  });
});
