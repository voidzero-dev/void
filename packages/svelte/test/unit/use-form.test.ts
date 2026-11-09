// @vitest-environment happy-dom

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Component } from 'svelte';
import { compile, compileModule } from 'svelte/compiler';
import { transformWithOxc } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { VoidRouter } from 'void/pages-client';

type TestForm = {
  readonly data: Record<string, unknown>;
  readonly errors: Record<string, string>;
  readonly hasChanges: boolean;
  readonly pending: boolean;
  readonly wasSuccessful: boolean;
  setError(field: string, message: string): void;
  post(): Promise<void>;
};

type TestIslandForm = {
  readonly errors: Record<string, string>;
  readonly pending: boolean;
  readonly wasSuccessful: boolean;
  post(url: string): Promise<void>;
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
let useIslandForm: (defaults: Record<string, unknown>) => TestIslandForm;
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
  const islandSource = join(import.meta.dirname, '../../src/runtime/use-island-form.svelte.ts');
  const island = await transformWithOxc(readFileSync(islandSource, 'utf8'), islandSource);
  writeCompiled(
    'use-island-form.svelte.js',
    compileModule(island.code, { filename: islandSource, generate: 'client' }).js.code,
  );
  ({ useIslandForm } = await import(pathToFileURL(join(TMP, 'use-island-form.svelte.js')).href));
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  for (const component of mounted.splice(0)) {
    void svelte.unmount(component);
  }
});

function mountForm(
  defaults: Record<string, unknown>,
  router = { visit: async () => ({}) } as unknown as VoidRouter,
): TestForm {
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function validationResponse(errors: Record<string, string>): Response {
  return new Response(JSON.stringify({ errors }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mountOverlappingForm() {
  const visits: Array<Deferred<unknown>> = [];
  const router = {
    visit: () => {
      const visit = deferred<unknown>();
      visits.push(visit);
      return visit.promise;
    },
  } as unknown as VoidRouter;
  return { form: mountForm({ title: '' }, router), visits };
}

describe('useForm overlapping submits', () => {
  it('stays pending when the router aborts an older submit', async () => {
    const { form, visits } = mountOverlappingForm();
    const first = form.post();
    const second = form.post();

    visits[0].reject(new DOMException('Navigation aborted', 'AbortError'));
    await first;
    expect(form.pending).toBe(true);

    visits[1].resolve({});
    await second;
    expect(form.pending).toBe(false);
    expect(form.wasSuccessful).toBe(true);
  });

  it('ignores an older submit that finishes first', async () => {
    const { form, visits } = mountOverlappingForm();
    const first = form.post();
    const second = form.post();

    visits[0].resolve({ errors: { title: 'Stale' } });
    await first;
    expect(form.pending).toBe(true);
    expect({ ...form.errors }).toEqual({});

    visits[1].resolve({ errors: { title: 'Invalid' } });
    await second;
    expect(form.pending).toBe(false);
    expect({ ...form.errors }).toEqual({ title: 'Invalid' });
  });

  it('ignores an older submit that finishes last', async () => {
    const { form, visits } = mountOverlappingForm();
    form.data.title = 'Edited';
    const first = form.post();
    const second = form.post();

    visits[1].resolve({ errors: { title: 'Invalid' } });
    await second;
    visits[0].resolve({});
    await first;

    expect(form.wasSuccessful).toBe(false);
    expect({ ...form.errors }).toEqual({ title: 'Invalid' });
    expect(form.hasChanges).toBe(true);
  });

  it('rejects an older submit that fails without changing the form', async () => {
    const { form, visits } = mountOverlappingForm();
    const first = form.post();
    const second = form.post();

    visits[0].reject(new Error('Older failure'));
    await expect(first).rejects.toThrow('Older failure');
    expect(form.pending).toBe(true);

    visits[1].resolve({});
    await second;
    expect(form.pending).toBe(false);
  });
});

describe('useIslandForm overlapping submits', () => {
  const originalLocation = window.location;

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  function stubIslandPage() {
    const responses: Array<Deferred<Response>> = [];
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost/test', reload },
      writable: true,
      configurable: true,
    });
    vi.stubGlobal('fetch', () => {
      const response = deferred<Response>();
      responses.push(response);
      return response.promise;
    });
    return { responses, reload };
  }

  it('ignores an older submit that finishes first', async () => {
    const { responses } = stubIslandPage();
    const form = useIslandForm({ title: '' });
    const first = form.post('/island');
    const second = form.post('/island');

    responses[0].resolve(validationResponse({ title: 'Stale' }));
    await first;
    expect(form.pending).toBe(true);
    expect({ ...form.errors }).toEqual({});

    responses[1].resolve(validationResponse({ title: 'Invalid' }));
    await second;
    expect(form.pending).toBe(false);
    expect({ ...form.errors }).toEqual({ title: 'Invalid' });
  });

  it('does not reload for an older submit that finishes last', async () => {
    const { responses, reload } = stubIslandPage();
    const form = useIslandForm({ title: '' });
    const first = form.post('/island');
    const second = form.post('/island');

    responses[1].resolve(validationResponse({ title: 'Invalid' }));
    await second;
    responses[0].resolve(new Response('{}', { status: 200 }));
    await first;

    expect(reload).not.toHaveBeenCalled();
    expect(form.wasSuccessful).toBe(false);
    expect({ ...form.errors }).toEqual({ title: 'Invalid' });
  });
});
