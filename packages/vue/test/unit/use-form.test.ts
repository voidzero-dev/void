import { describe, expect, it } from 'vite-plus/test';
import type { VoidRouter } from 'void/pages-client';
import { createSSRApp, defineComponent, h, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { useForm as typedUseForm } from '../../src/runtime/use-form.ts';

type TestForm = {
  setError(field: string, message: string): void;
  readonly errors: Record<string, string>;
  data: Record<string, unknown>;
  hasChanges: boolean;
  pending: boolean;
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
): Promise<TestForm> {
  const router = {
    visit: async () => ({}),
  } as unknown as VoidRouter;
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
