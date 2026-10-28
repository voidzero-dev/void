import { VoidActionError } from 'void/pages-client';
import { useForm } from '../../src/runtime/use-form.ts';

declare module 'void/routes' {
  interface PageActionMap {
    '/__form-options/notes': { actions: { create: { body: { title: string } } } };
    '/__form-options/notes/:id': { body: { title: string }; params: { id: string } };
  }
}

export function checkFormOptions(): void {
  useForm(
    '/__form-options/notes?create',
    { title: '' },
    {
      resetOnSuccess: true,
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
}
