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
  // @ts-expect-error Form state is read-only.
  form.pending = true;
}
