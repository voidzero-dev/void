import { createComponent, createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { VoidRouter } from 'void/pages-client';
import { RouterContext } from '../../src/runtime/context.ts';
import { useForm as typedUseForm } from '../../src/runtime/use-form.ts';

beforeEach(() => {
  vi.stubGlobal('window', { location: { pathname: '/', search: '' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The public overload only accepts generated action URLs; these tests use plain paths.
const useForm = typedUseForm as unknown as (
  url: string,
  defaults: Record<string, unknown>,
  options: { params: Record<string, string> },
) => { post(): Promise<void>; readonly pending: boolean };

function renderForm(url: string, params: Record<string, string>) {
  const visits: Array<string> = [];
  const router = {
    visit: async (target: string) => {
      visits.push(target);
      return {};
    },
  } as unknown as VoidRouter;
  let form!: ReturnType<typeof useForm>;
  // Rendering stays possible whatever the param holds; only a submit resolves it.
  createRoot(() =>
    createComponent(RouterContext.Provider, {
      value: router,
      get children() {
        form = useForm(url, {}, { params });
        return null;
      },
    }),
  );
  return { form, visits };
}

describe('useForm params', () => {
  it('fills in params and keeps the action query', async () => {
    const { form, visits } = renderForm('/users/:name/follow?action=follow', { name: 'a b/c' });
    await form.post();
    expect(visits).toEqual(['/users/a%20b%2Fc/follow?action=follow']);
  });

  it.each(['.', '..'])('refuses to submit when a param is %j', async (name) => {
    const { form, visits } = renderForm('/users/:name/follow', { name });
    await expect(form.post()).rejects.toThrow(TypeError);
    expect(visits).toEqual([]);
    expect(form.pending).toBe(false);
  });
});
