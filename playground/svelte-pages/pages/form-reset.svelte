<script lang="ts">
  import { Form, useForm } from '@void/svelte';

  const forms = [false, true].map((automatic) => ({
    id: automatic ? 'automatic-form' : 'manual-form',
    form: useForm('/form-reset', { profile: { name: '' }, tags: [] }, {
      resetOnSuccess: automatic,
    }),
  }));

  function edit(form: (typeof forms)[number]['form']) {
    form.data.profile.name = 'edited';
    form.data.tags.push('edited');
  }
</script>

{#each forms as { id, form } (id)}
  <section data-testid={id}>
    <Form {form}>
      <output data-testid="values">{JSON.stringify(form.data)}</output>
      <output data-testid="dirty">{String(form.hasChanges)}</output>
      <output data-testid="success">{String(form.wasSuccessful)}</output>
      <button type="button" onclick={() => edit(form)}>Edit</button>
      <button type="button" onclick={() => form.reset({})}>Reset current</button>
      <button type="button" onclick={() => form.reset({ initial: true })}>Reset initial</button>
      <button type="button" onclick={() => form.reset({ initial: true }, 'profile')}>Reset profile</button>
      <button type="submit" disabled={form.pending}>Save</button>
    </Form>
  </section>
{/each}
