import { Form, useForm } from '@void/solid';

function ResetForm({ automatic }: { automatic: boolean }) {
  const form = useForm(
    '/form-reset',
    { profile: { name: '' }, tags: [] },
    {
      resetOnSuccess: automatic,
    },
  );

  function edit() {
    form.setData('profile', { name: 'edited' });
    form.setData('tags', [...form.data.tags, 'edited']);
  }

  return (
    <section data-testid={automatic ? 'automatic-form' : 'manual-form'}>
      <Form form={form}>
        <output data-testid="values">{JSON.stringify(form.data)}</output>
        <output data-testid="dirty">{String(form.hasChanges)}</output>
        <output data-testid="success">{String(form.wasSuccessful)}</output>
        <button type="button" onClick={edit}>
          Edit
        </button>
        <button type="button" onClick={() => form.reset({})}>
          Reset current
        </button>
        <button type="button" onClick={() => form.reset({ initial: true })}>
          Reset initial
        </button>
        <button type="button" onClick={() => form.reset({ initial: true }, 'profile')}>
          Reset profile
        </button>
        <button type="submit" disabled={form.pending}>
          Save
        </button>
      </Form>
    </section>
  );
}

export default function FormResetPage() {
  return (
    <>
      <ResetForm automatic={false} />
      <ResetForm automatic={true} />
    </>
  );
}
