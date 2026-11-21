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

function createForm(
  server: Record<string, string> = { email: 'Invalid email', name: 'Required' },
  defaults: Record<string, unknown> = { email: '', name: '' },
) {
  const [serverErrors, setServerErrors] = createSignal(server);
  let form!: TestForm;
  const dispose = createRoot((dispose) => {
    createComponent(ErrorsContext.Provider, {
      value: serverErrors,
      get children() {
        form = useForm('/test', defaults);
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

  it('clears nested errors below a replaced parent field and a cleared parent', () => {
    const { form, dispose } = createForm(
      {
        'profile.name': 'Required name',
        'contacts.0.email': 'Required email',
        name: 'Unrelated',
      },
      { profile: { name: '' }, contacts: [{ email: '' }] },
    );
    try {
      expect(form.errors).toEqual({
        'profile.name': 'Required name',
        'contacts.0.email': 'Required email',
        name: 'Unrelated',
      });

      form.clearErrors('profile');
      expect(form.errors).toEqual({ 'contacts.0.email': 'Required email', name: 'Unrelated' });

      form.setError('profile.name', 'Required name');
      form.setData('profile', { name: 'Alex' });
      expect(form.errors).toEqual({ 'contacts.0.email': 'Required email', name: 'Unrelated' });

      form.setData('contacts', [{ email: 'alex@example.com' }]);
      expect(form.errors).toEqual({ name: 'Unrelated' });

      form.clearErrors('name');
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
