import { VoidActionError } from 'void/pages-client';
import type { FormState } from 'void/pages-client';
import { useForm } from '../../src/runtime/use-form.ts';

export function checkGenericFieldHelpers<T>(
  form: FormState<T, 'setters'>,
  field: keyof T & string,
): string | undefined {
  form.setError(field, 'Client-side');
  form.clearErrors(field);
  return form.errors[field];
}

declare module 'void/routes' {
  interface PageActionMap {
    '/__form-options/notes': { actions: { create: { body: { title: string } } } };
    '/__form-options/notes/:id': { body: { title: string }; params: { id: string } };
    '/__form-options/nested': {
      body: { profile: { name: string }; contacts: Array<{ email: string }> };
    };
  }
}

export function checkNestedErrorPaths(): void {
  const form = useForm('/__form-options/nested', {
    profile: { name: '' },
    contacts: [{ email: '' }],
  });
  const name: string | undefined = form.errors['profile.name'];
  const email: string | undefined = form.errors['contacts.0.email'];
  void name;
  void email;
  form.setError('profile.name', 'Required name');
  form.setError('contacts.0.email', 'Required email');
  form.clearErrors('profile', 'contacts', 'contacts.0.email');
  // @ts-expect-error Nested error paths must name a field in the action body.
  form.setError('profile.missing', 'Invalid');
  // @ts-expect-error Array segments must be numeric array indices.
  form.clearErrors('contacts.first');
}

export function checkFormOptions(): void {
  useForm(
    '/__form-options/notes?create',
    { title: '' },
    {
      resetOnSuccess: true,
      preserveScroll: false,
      onSuccess: async () => {},
      onError: async (error) => {
        if (error instanceof VoidActionError) {
          const status: number = error.status;
          void status;
        } else {
          const title: string = error.title;
          void title;
        }
      },
    },
  );
  useForm(
    '/__form-options/notes/:id',
    { title: '' },
    {
      params: { id: '1' },
      onSuccess: () => {},
      onError: () => {},
    },
  );
  useForm(
    '/__form-options/notes?create',
    { title: '' },
    // @ts-expect-error Static actions do not accept route params.
    { params: { id: '1' }, onSuccess: () => {} },
  );
  // @ts-expect-error Dynamic action params remain required with callbacks.
  useForm('/__form-options/notes/:id', { title: '' }, { onSuccess: () => {} });
  useForm(
    '/__form-options/notes/:id',
    { title: '' },
    // @ts-expect-error Callbacks do not allow extra dynamic route params.
    { params: { id: '1', missing: '2' }, onSuccess: () => {} },
  );
  // @ts-expect-error Callback options retain the action body type.
  useForm('/__form-options/notes?create', { missing: '' }, { onSuccess: () => {} });
  // @ts-expect-error Success callbacks return void or a promise of void.
  useForm('/__form-options/notes?create', { title: '' }, { onSuccess: () => 123 });
  // @ts-expect-error Scroll preservation must be a boolean.
  useForm('/__form-options/notes?create', { title: '' }, { preserveScroll: 'yes' });
}
