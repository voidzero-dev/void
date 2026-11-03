import type { FormModel } from 'void/pages-client';
import { useForm } from '../../src/runtime/use-form.ts';

declare module 'void/routes' {
  interface PageActionMap {
    '/__form-errors/react': { body: { email: string } };
  }
}

export function checkFieldErrors(): void {
  const form = useForm('/__form-errors/react', { email: '' });
  form.setError('email', 'Invalid email');
  // @ts-expect-error Error fields must exist in the action body.
  form.setError('missing', 'Invalid field');
  // @ts-expect-error Error messages must be strings.
  form.setError('email', 123);
  // @ts-expect-error Form state is read-only; update fields with `setData`.
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
  // @ts-expect-error Errors change through setError and clearErrors.
  form.errors.email = 'Invalid';
  // @ts-expect-error Fields change through setData.
  form.data.email = '';
  // @ts-expect-error Form methods are read-only.
  form.clearError = () => {};
  // @ts-expect-error Submit methods are form actions that take FormData.
  form.post();
  const model: FormModel<[FormData]> = form;
  void model;
}
