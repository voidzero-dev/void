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
  form.errors.title = 'Invalid';
  void form.post('/notes');
  form.data.title = 'Hello';
  void form.submit('/notes', 'PATCH');
  // @ts-expect-error Vue edits `data` in place, so there is no setData.
  form.setData('title', 'Hello');
}
