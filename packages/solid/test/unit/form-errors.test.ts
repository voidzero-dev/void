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
  data: Readonly<Record<string, unknown>>;
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

  it('clears only the errors of the fields a change touched', () => {
    const { form, dispose } = createForm(
      {
        'profile.name': 'Required name',
        'profile.email': 'Required email',
        'contacts.0.email': 'First email',
        'contacts.1.email': 'Second email',
        name: 'Unrelated',
      },
      {
        profile: { name: '', email: '' },
        contacts: [{ email: '' }, { email: '' }],
      },
    );
    try {
      form.setData('profile', { name: 'Alex', email: '' });
      expect(form.errors).toEqual({
        'profile.email': 'Required email',
        'contacts.0.email': 'First email',
        'contacts.1.email': 'Second email',
        name: 'Unrelated',
      });

      form.setData('contacts', [{ email: '' }, { email: 'alex@example.com' }]);
      expect(form.errors).toEqual({
        'profile.email': 'Required email',
        'contacts.0.email': 'First email',
        name: 'Unrelated',
      });

      form.clearErrors('profile');
      expect(form.errors).toEqual({ 'contacts.0.email': 'First email', name: 'Unrelated' });

      form.setError('profile.name', 'Required name');
      expect(form.errors).toEqual({
        'profile.name': 'Required name',
        'contacts.0.email': 'First email',
        name: 'Unrelated',
      });

      form.clearErrors('contacts');
      expect(form.errors).toEqual({ 'profile.name': 'Required name', name: 'Unrelated' });

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

it('keeps an untouched row error when clearing its parent array error', () => {
  const { form, dispose } = createForm(
    {
      contacts: 'At least one valid email required',
      'contacts.0.email': 'First email required',
      'contacts.1.email': 'Second email required',
    },
    { contacts: [{ email: '' }, { email: '' }] },
  );
  try {
    form.setData('contacts', [{ email: 'fixed@example.com' }, { email: '' }]);
    expect(form.errors).toEqual({ 'contacts.1.email': 'Second email required' });
  } finally {
    dispose();
  }
});

it('clears an array count error after adding an undefined entry', () => {
  const { form, dispose } = createForm({ contacts: 'Add a second row' }, { contacts: [undefined] });
  try {
    form.setData('contacts', [undefined, undefined]);
    expect(form.data.contacts).toEqual([undefined, undefined]);
    expect(form.errors).toEqual({});
  } finally {
    dispose();
  }
});

it('keeps a nested error for an optional key preserved by the store merge', () => {
  const { form, dispose } = createForm(
    { 'profile.nickname': 'Nickname unavailable' },
    { profile: { name: '', nickname: 'Reserved name' } },
  );
  try {
    form.setData('profile', { name: 'Alex' });
    expect(form.data.profile).toEqual({ name: 'Alex', nickname: 'Reserved name' });
    expect(form.errors).toEqual({ 'profile.nickname': 'Nickname unavailable' });
  } finally {
    dispose();
  }
});
