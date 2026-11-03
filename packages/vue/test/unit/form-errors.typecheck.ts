import type { FormModel } from 'void/pages-client';
import { useForm } from '../../src/runtime/use-form.ts';

declare module 'void/routes' {
  interface PageActionMap {
    '/__form-errors/vue': { body: { email: string } };
  }
}

export function checkFieldErrors(): void {
  const form = useForm('/__form-errors/vue', { email: '' });
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
  // @ts-expect-error Vue edits `data` in place, so there is no setData.
  form.setData('email', '');
  // @ts-expect-error Form methods are read-only.
  form.clearError = () => {};
  // @ts-expect-error The submit method sets the HTTP method.
  void form.post({ method: 'GET' });
  const model: FormModel = form;
  void model;
}
