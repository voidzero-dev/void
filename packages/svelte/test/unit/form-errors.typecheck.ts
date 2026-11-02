import { useForm } from '../../src/runtime/use-form.svelte.ts';

declare module 'void/routes' {
  interface PageActionMap {
    '/__form-errors/svelte': { body: { email: string } };
  }
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
  // @ts-expect-error Submission callbacks are specific to the React adapter.
  useForm('/__form-errors/svelte', { email: '' }, { onSuccess: () => {} });
  // @ts-expect-error Submission callbacks are specific to the React adapter.
  useForm('/__form-errors/svelte', { email: '' }, { onError: () => {} });
}
