import { Link, Form, useForm } from '@void/solid';
import { For, Show } from 'solid-js';
import type { Props } from './index.server.ts';

export default function UsersPage(props: Props) {
  const form = useForm('/users', {
    name: '',
    email: '',
  });

  return (
    <div>
      <h1>Users</h1>

      <ul>
        <For each={props.users}>
          {(user) => (
            <li>
              <Link href={`/users/${user.id}`} prefetch="visible">
                {user.name}
              </Link>{' '}
              ({user.email})
            </li>
          )}
        </For>
      </ul>

      <h2>Add User</h2>
      <Form form={form}>
        <div>
          <label>Name:</label>
          <input value={form.data.name} onInput={(e) => form.setData('name', e.target.value)} />
          <Show when={form.errors.name}>
            <span style={{ color: 'red' }}>{form.errors.name}</span>
          </Show>
        </div>
        <div>
          <label>Email:</label>
          <input value={form.data.email} onInput={(e) => form.setData('email', e.target.value)} />
          <Show when={form.errors.email}>
            <span style={{ color: 'red' }}>{form.errors.email}</span>
          </Show>
        </div>
        <button type="submit" disabled={form.pending}>
          {form.pending ? 'Saving...' : 'Add User'}
        </button>
      </Form>
    </div>
  );
}
