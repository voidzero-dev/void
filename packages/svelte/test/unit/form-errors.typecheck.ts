import type { FormModel } from 'void/pages-client';
import { useForm } from '../../src/runtime/use-form.svelte.ts';

declare module 'void/routes' {
  interface PageActionMap {
    '/__form-errors/svelte': { body: { email: string } };
    '/__form-errors/svelte-nested': {
      body: { profile: { name: string }; contacts: Array<{ email: string }> };
    };
  }
}

export function checkNestedErrorPaths(): void {
  const form = useForm('/__form-errors/svelte-nested', {
    profile: { name: '' },
    contacts: [{ email: '' }],
  });
  const name: string | undefined = form.errors['profile.name'];
  const email: string | undefined = form.errors['contacts.0.email'];
  void name;
  void email;
  form.errors['contacts.0.email'] = 'Required email';
  form.setError('profile.name', 'Required name');
  form.clearErrors('profile', 'contacts', 'contacts.0.email');
  // @ts-expect-error Nested error paths must name a field in the action body.
  form.setError('profile.missing', 'Invalid');
  // @ts-expect-error Array segments must be numeric array indices.
  form.clearErrors('contacts.first');
}

export function checkFieldErrors(): void {
  const form = useForm('/__form-errors/svelte', { email: '' });
  form.setError('email', 'Invalid email');
  // @ts-expect-error Error fields must exist in the action body.
  form.setError('missing', 'Invalid field');
  // @ts-expect-error Error messages must be strings.
  form.setError('email', 123);
  form.data.email = '';
  // @ts-expect-error Form state is read-only; edit fields through `data`.
  form.data = { email: '' };
  // @ts-expect-error Form state is read-only.
  form.errors = {};
  // @ts-expect-error Form state is read-only.
  form.error = null;
  // @ts-expect-error Form state is read-only.
  form.pending = true;
  // @ts-expect-error Form state is read-only.
  form.hasChanges = true;
  // @ts-expect-error Form state is read-only.
  form.wasSuccessful = true;
  // @ts-expect-error Form state is read-only.
  form.recentlySuccessful = true;
  form.errors.email = 'Invalid';
  // @ts-expect-error Svelte edits `data` in place, so there is no setData.
  void form.setData;
  // @ts-expect-error Form methods are read-only.
  form.clearError = () => {};
  // @ts-expect-error The submit method sets the HTTP method.
  void form.post({ method: 'GET' });
  const model: FormModel = form;
  void model;
  // @ts-expect-error Submission callbacks are specific to the React adapter.
  useForm('/__form-errors/svelte', { email: '' }, { onSuccess: () => {} });
  // @ts-expect-error Submission callbacks are specific to the React adapter.
  useForm('/__form-errors/svelte', { email: '' }, { onError: () => {} });
}
