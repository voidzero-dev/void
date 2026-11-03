import { useForm } from '../../src/runtime/use-form.ts';

declare module 'void/routes' {
  interface PageActionMap {
    '/__form-test/notes': { actions: { create: { body: { title: string } } } };
    '/__form-test/notes/:id': { body: { title: string }; params: { id: string } };
  }
}

export function checkFormOptions(): void {
  const form = useForm('/__form-test/notes?create', { title: '' }, { resetOnSuccess: true });
  form.reset({});
  form.reset({ initial: true }, 'title');
  useForm('/__form-test/notes/:id', { title: '' }, { params: { id: '1' }, resetOnSuccess: true });
  // @ts-expect-error Static actions do not accept route params.
  useForm('/__form-test/notes?create', { title: '' }, { params: { id: '1' } });
  // @ts-expect-error Dynamic action params remain required when options are provided.
  useForm('/__form-test/notes/:id', { title: '' }, { resetOnSuccess: true });
  // @ts-expect-error Reset field names retain the action body type.
  form.reset({ initial: true }, 'missing');
  // @ts-expect-error Submission callbacks are specific to the React adapter.
  useForm('/__form-test/notes?create', { title: '' }, { onSuccess: () => {} });
  // @ts-expect-error Submission callbacks are specific to the React adapter.
  useForm('/__form-test/notes?create', { title: '' }, { onError: () => {} });
}
