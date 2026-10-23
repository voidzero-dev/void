import { describe, expect, it } from 'vite-plus/test';
import type { VoidRouter } from 'void/pages-client';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { useForm as typedUseForm } from '../../src/runtime/use-form.ts';

type TestForm = {
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
