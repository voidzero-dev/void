import { Form, useForm } from '@void/react';

export default function FormErrorsPage() {
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

  return (
    <Form form={form}>
      <output data-testid="errors">{JSON.stringify(form.errors)}</output>
      <label>
        Email
        <input
          value={form.data.email}
          onChange={(event) => {
            form.setData('email', event.currentTarget.value);
            if (!event.currentTarget.value.includes('@')) {
              form.setError('email', 'Client email invalid');
            }
          }}
        />
      </label>
      <label>
        Name
        <input
          value={form.data.name}
          onChange={(event) => form.setData('name', event.currentTarget.value)}
        />
      </label>
      <label>
        Profile
        <input
          value={form.data.profile.name}
          onChange={(event) => form.setData('profile', { name: event.currentTarget.value })}
        />
      </label>
      <button type="button" onClick={() => form.setData('tags', [...form.data.tags, 'tag'])}>
        Add tag
      </button>
      <button type="button" onClick={setErrors}>
        Set errors
      </button>
      <button type="button" onClick={setNestedErrors}>
        Set nested errors
      </button>
      <button type="button" onClick={() => form.clearErrors('email')}>
        Clear email
      </button>
      <button type="button" onClick={() => form.clearErrors()}>
        Clear all
      </button>
      <button type="submit" disabled={form.pending}>
        Save
      </button>
    </Form>
  );
}
