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
  // @ts-expect-error Island form state is read-only.
  form.data = { title: '', count: 0 };
  // @ts-expect-error Island form state is read-only.
  form.errors = {};
  // @ts-expect-error Form methods are read-only.
  form.clearError = () => {};
  // Island errors are keyed by whatever names the action returns.
  const nestedError: string | undefined = form.errors['items.0.name'];
  void nestedError;
  const titleError: string | undefined = form.errors.title;
  void titleError;
  // @ts-expect-error A field may have no error.
  void form.errors.title.length;
  // @ts-expect-error Island errors are read-only.
  form.errors.title = 'Invalid';
  // @ts-expect-error Fields change through setData.
  form.data.title = '';
  void form.post('/notes');
  form.setData('title', 'Hello');
  // @ts-expect-error Field values keep their default types.
  form.setData('count', '1');
  // @ts-expect-error Only Vue and Svelte islands expose submit().
  void form.submit('/notes', 'PATCH');
}
