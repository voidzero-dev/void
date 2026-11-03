<script lang="ts">
  import { Form, useForm } from '@void/svelte';
  const form = useForm('/form-errors', { email: '', name: '', profile: { name: '' }, tags: [] });

  function setErrors() {
    form.setError('email', 'Email invalid');
    form.setError('name', 'Name invalid');
    setNestedErrors();
  }

  function setNestedErrors() {
    form.setError('profile', 'Profile invalid');
    form.setError('tags', 'Tags invalid');
  }

  function editEmail(event: Event) {
    form.data.email = (event.target as HTMLInputElement).value;
    if (!form.data.email.includes('@')) {
      form.errors.email = 'Client email invalid';
    }
  }
</script>

<Form {form}>
  <output data-testid="errors">{JSON.stringify(form.errors)}</output>
  <label>Email<input value={form.data.email} oninput={editEmail} /></label>
  <label>Name<input bind:value={form.data.name} /></label>
  <label>Profile<input bind:value={form.data.profile.name} /></label>
  <button type="button" onclick={() => form.data.tags.push('tag')}>Add tag</button>
  <button type="button" onclick={setErrors}>Set errors</button>
  <button type="button" onclick={setNestedErrors}>Set nested errors</button>
  <button type="button" onclick={() => form.clearErrors('email')}>Clear email</button>
  <button type="button" onclick={() => form.clearErrors()}>Clear all</button>
  <button type="submit" disabled={form.pending}>Save</button>
</Form>
