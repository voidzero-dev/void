import { Link, Form, useForm } from '@void/hono';
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
        {props.users.map((user) => (
          <li key={user.id}>
            <Link href={`/users/${user.id}`} prefetch="visible">
              {user.name}
            </Link>{' '}
            ({user.email})
          </li>
        ))}
      </ul>

      <h2>Add User</h2>
      <Form form={form}>
        <div>
          <label>Name:</label>
          <input
            value={form.data.name as string}
            onInput={(e) => form.setData('name', (e.target as HTMLInputElement).value)}
          />
          {form.errors.name && <span style={{ color: 'red' }}>{form.errors.name}</span>}
        </div>
        <div>
          <label>Email:</label>
          <input
            value={form.data.email as string}
            onInput={(e) => form.setData('email', (e.target as HTMLInputElement).value)}
          />
          {form.errors.email && <span style={{ color: 'red' }}>{form.errors.email}</span>}
        </div>
        <button type="submit" disabled={form.pending}>
          {form.pending ? 'Saving...' : 'Add User'}
        </button>
      </Form>
    </div>
  );
}
