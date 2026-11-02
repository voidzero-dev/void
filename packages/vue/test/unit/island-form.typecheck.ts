import { useIslandForm } from '../../src/runtime/use-island-form.ts';

export function checkIslandForm(): void {
  const form = useIslandForm({ title: '', count: 0 });
  const title: string = form.data.title;
  const count: number = form.data.count;
  void title;
  void count;
  form.reset('title');
  // @ts-expect-error Reset fields must exist in the defaults.
  form.reset('missing');
  // @ts-expect-error Island form state is read-only.
  form.pending = true;
  const titleError: string | undefined = form.errors.title;
  void titleError;
  // @ts-expect-error A field may have no error.
  void form.errors.title.length;
  // @ts-expect-error Island errors are read-only.
  form.errors.title = 'Invalid';
  void form.post('/notes');
  form.data.title = 'Hello';
  void form.submit('/notes', 'PATCH');
}
