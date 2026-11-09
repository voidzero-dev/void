import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { VoidRouter } from 'void/pages-client';
import { createSSRApp, defineComponent, h, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { useForm as typedUseForm } from '../../src/runtime/use-form.ts';
import { useIslandForm } from '../../src/runtime/use-island-form.ts';

type TestForm = {
  setError(field: string, message: string): void;
  readonly errors: Record<string, string>;
  data: Record<string, unknown>;
  hasChanges: boolean;
  pending: boolean;
  wasSuccessful: boolean;
  post(): Promise<void>;
  reset: (...args: Array<string | { initial?: boolean }>) => void;
};

// The public overload only accepts generated action URLs; these tests use plain paths.
const useForm = typedUseForm as unknown as (
  url: string,
  defaults: Record<string, unknown>,
  options?: { params?: Record<string, string>; resetOnSuccess?: boolean },
) => TestForm;

async function renderForm(url: string, params: Record<string, string>) {
  const visits: Array<string> = [];
  const router = {
    visit: async (target: string) => {
      visits.push(target);
      return {};
    },
  } as unknown as VoidRouter;
  let form!: ReturnType<typeof useForm>;
  const app = createSSRApp(
    defineComponent({
      setup() {
        form = useForm(url, {}, { params });
        return () => h('form');
      },
    }),
  );
  app.provide('__void_router', router);
  // Rendering stays possible whatever the param holds; only a submit resolves it.
  await renderToString(app);
  return { form, visits };
}

async function mountForm(
  defaults: Record<string, unknown>,
  options?: { resetOnSuccess?: boolean },
  router = { visit: async () => ({}) } as unknown as VoidRouter,
): Promise<TestForm> {
  let form!: TestForm;
  const app = createSSRApp(
    defineComponent({
      setup() {
        form = useForm('/notes?create', defaults, options);
        return () => h('form');
      },
    }),
  );
  app.provide('__void_router', router);
  await renderToString(app);
  return form;
}

describe('useForm reset', () => {
  it('reset() restores submitted values after success', async () => {
    const form = await mountForm({ title: '', body: '' });
    form.data.title = 'Hello';
    await form.post();
    form.data.title = 'Changed';
    form.reset();
    expect(form.data.title).toBe('Hello');
    expect(form.hasChanges).toBe(false);
  });

  it('reset({ initial: true }) restores mount-time defaults after success', async () => {
    const form = await mountForm({ title: '', body: '' });
    form.data.title = 'Hello';
    await form.post();
    form.reset({ initial: true });
    expect(form.data.title).toBe('');
  });

  it('resetOnSuccess clears create forms after a successful submit', async () => {
    const form = await mountForm({ title: '', body: '' }, { resetOnSuccess: true });
    form.data.title = 'Hello';
    await form.post();
    expect(form.data.title).toBe('');
    expect(form.hasChanges).toBe(false);
  });

  it.each([false, true])(
    'restores nested initial values repeatedly (automatic=%s)',
    async (automatic) => {
      const defaults = { profile: { name: '' }, tags: [] as Array<string> };
      const form = await mountForm(defaults, { resetOnSuccess: automatic });
      for (let index = 0; index < 2; index++) {
        (form.data.profile as { name: string }).name = 'Alice';
        (form.data.tags as Array<string>).push('react');
        await form.post();
        if (!automatic) {
          form.reset({ initial: true });
        }
        expect(form.data).toEqual({ profile: { name: '' }, tags: [] });
        expect(defaults).toEqual({ profile: { name: '' }, tags: [] });
      }
    },
  );

  it('resets with empty options without adding a field', async () => {
    const form = await mountForm({ title: '' });
    form.data.title = 'Hello';
    form.reset({});
    expect(form.data).toEqual({ title: '' });
  });
});

describe('useForm setError', () => {
  it('clears errors after repeated nested object and array edits', async () => {
    const app = createSSRApp(
      defineComponent({
        setup() {
          const form = useForm('/test', { profile: { name: '' }, tags: [] });
          for (let edit = 0; edit < 3; edit++) {
            form.setError('profile', 'Invalid profile');
            form.setError('tags', 'Invalid tags');
            (form.data.profile as { name: string }).name = 'Name ' + edit;
            expect(form.errors.profile).toBeUndefined();
            expect(form.errors.tags).toBe('Invalid tags');
            (form.data.tags as Array<string>).push('tag');
            expect(form.errors).toEqual({});
          }
          return () => h('form');
        },
      }),
    );
    app.provide('__void_router', { visit: async () => ({}) });
    await renderToString(app);
  });

  it('sets a field error and clears it when data changes', async () => {
    const router = {
      visit: async () => ({}),
    } as unknown as VoidRouter;
    const app = createSSRApp(
      defineComponent({
        async setup() {
          const form = useForm('/test', { email: '', name: '' }, {});
          form.setError('email', 'Invalid email');
          expect(form.errors.email).toBe('Invalid email');
          form.data.email = 'a@example.com';
          await nextTick();
          expect(form.errors.email).toBeUndefined();
          return () => h('form');
        },
      }),
    );
    app.provide('__void_router', router);
    await renderToString(app);
  });

  it('keeps errors on other fields when one field changes', async () => {
    const router = {
      visit: async () => ({}),
    } as unknown as VoidRouter;
    const app = createSSRApp(
      defineComponent({
        setup() {
          const form = useForm('/test', { email: '', name: '' }, {});
          form.setError('email', 'Invalid email');
          form.setError('name', 'Required');
          form.data.email = 'a@example.com';
          expect(form.errors.name).toBe('Required');
          return () => h('form');
        },
      }),
    );
    app.provide('__void_router', router);
    await renderToString(app);
  });
});

describe('useForm params', () => {
  it('fills in params and keeps the action query', async () => {
    const { form, visits } = await renderForm('/users/:name/follow?action=follow', {
      name: 'a b/c',
    });
    await form.post();
    expect(visits).toEqual(['/users/a%20b%2Fc/follow?action=follow']);
  });

  it.each(['.', '..'])('refuses to submit when a param is %j', async (name) => {
    const { form, visits } = await renderForm('/users/:name/follow', { name });
    await expect(form.post()).rejects.toThrow(TypeError);
    expect(visits).toEqual([]);
    expect(form.pending).toBe(false);
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

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountOverlappingForm() {
  const visits: Array<Deferred<unknown>> = [];
  const router = {
    visit: () => {
      const visit = deferred<unknown>();
      visits.push(visit);
      return visit.promise;
    },
  } as unknown as VoidRouter;
  return { form: await mountForm({ title: '' }, undefined, router), visits };
}

describe('useForm overlapping submits', () => {
  it('stays pending when the router aborts an older submit', async () => {
    const { form, visits } = await mountOverlappingForm();
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
    const { form, visits } = await mountOverlappingForm();
    const first = form.post();
    const second = form.post();

    visits[0].resolve({ errors: { title: 'Stale' } });
    await first;
    expect(form.pending).toBe(true);
    expect(form.errors).toEqual({});

    visits[1].resolve({ errors: { title: 'Invalid' } });
    await second;
    expect(form.pending).toBe(false);
    expect(form.errors).toEqual({ title: 'Invalid' });
  });

  it('ignores an older submit that finishes last', async () => {
    const { form, visits } = await mountOverlappingForm();
    form.data.title = 'Edited';
    const first = form.post();
    const second = form.post();

    visits[1].resolve({ errors: { title: 'Invalid' } });
    await second;
    visits[0].resolve({});
    await first;

    expect(form.wasSuccessful).toBe(false);
    expect(form.errors).toEqual({ title: 'Invalid' });
    expect(form.hasChanges).toBe(true);
  });

  it('rejects an older submit that fails without changing the form', async () => {
    const { form, visits } = await mountOverlappingForm();
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
  function stubIslandPage() {
    const responses: Array<Deferred<Response>> = [];
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { href: 'http://localhost/test', reload } });
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
    expect(form.errors).toEqual({});

    responses[1].resolve(validationResponse({ title: 'Invalid' }));
    await second;
    expect(form.pending).toBe(false);
    expect(form.errors).toEqual({ title: 'Invalid' });
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
    expect(form.errors).toEqual({ title: 'Invalid' });
  });
});
