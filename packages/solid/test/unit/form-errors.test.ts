import { createComponent, createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vite-plus/test';
import { ErrorsContext } from '../../src/runtime/context.ts';
import { useForm as typedUseForm } from '../../src/runtime/use-form.ts';

// Client memos must react to edits; Solid's server runtime evaluates them only once.
vi.mock('solid-js', () => vi.importActual<typeof import('solid-js')>('solid-js/dist/solid.js'));
vi.mock('solid-js/store', () =>
  vi.importActual<typeof import('solid-js/store')>('solid-js/store/dist/store.js'),
);

type TestForm = {
  errors: Record<string, string>;
  setData(field: string, value: unknown): void;
  setError(field: string, message: string): void;
  clearErrors(...fields: Array<string>): void;
};
const useForm = typedUseForm as unknown as (
  url: string,
  defaults: Record<string, unknown>,
) => TestForm;

function createForm() {
  const [serverErrors, setServerErrors] = createSignal({
    email: 'Invalid email',
    name: 'Required',
  });
  let form!: TestForm;
  const dispose = createRoot((dispose) => {
    createComponent(ErrorsContext.Provider, {
      value: serverErrors,
      get children() {
        form = useForm('/test', { email: '', name: '' });
        return null;
      },
    });
    return dispose;
  });
  return { form, setServerErrors, dispose };
}

describe('useForm router errors', () => {
  it('keeps unrelated server errors when adding client errors', () => {
    const { form, dispose } = createForm();
    try {
      form.setError('name', 'Client error');
      expect(form.errors).toEqual({ email: 'Invalid email', name: 'Client error' });
    } finally {
      dispose();
    }
  });

  it('clears server errors without reviving them after local edits', () => {
    const { form, dispose } = createForm();
    try {
      form.setData('email', 'valid@example.com');
      expect(form.errors).toEqual({ name: 'Required' });
      form.setError('email', 'Client error');
      form.clearErrors('name');
      form.setData('email', 'other@example.com');
      expect(form.errors).toEqual({});
      form.clearErrors();
      expect(form.errors).toEqual({});
    } finally {
      dispose();
    }
  });

  it('shows new server results after earlier errors were cleared', () => {
    const { form, setServerErrors, dispose } = createForm();
    try {
      form.clearErrors();
      expect(form.errors).toEqual({});
      setServerErrors({ email: 'New email error', name: 'New name error' });
      expect(form.errors).toEqual({ email: 'New email error', name: 'New name error' });
    } finally {
      dispose();
    }
  });
});
