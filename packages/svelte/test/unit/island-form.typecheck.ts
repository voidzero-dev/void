import { useIslandForm } from '../../src/runtime/use-island-form.svelte.ts';

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
  void form.post('/notes');
  form.data.title = 'Hello';
  void form.submit('/notes', 'PATCH');
}
