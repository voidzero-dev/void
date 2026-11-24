import { useForm, action } from '@void/react';
import type { Props } from './index.server.ts';

export default function DbPage({ users, posts }: Props) {
  const userForm = useForm('/?create-user', {
    name: '',
    email: '',
  });

  const postForm = useForm('/?create-post', {
    title: '',
    body: '',
    authorId: 0,
  });

  async function deleteUser(id: number) {
    await action('/?delete-user', { data: { id } });
  }

  async function deletePost(id: number) {
    await action('/?delete-post', { data: { id } });
  }

  return (
    <div>
      <h1>Database (PostgreSQL)</h1>
      <p>
        PostgreSQL via <code>void/db</code> + Drizzle ORM.
      </p>

      <h2>Add User</h2>
      <form action={userForm.post}>
        <div>
          <label>Name: </label>
          <input
            value={userForm.data.name}
            onChange={(e) => userForm.setData('name', e.target.value)}
            placeholder="Name"
            required
          />
        </div>
        <div style={{ marginTop: 5 }}>
          <label>Email: </label>
          <input
            value={userForm.data.email}
            onChange={(e) => userForm.setData('email', e.target.value)}
            placeholder="Email"
            required
          />
        </div>
        <button type="submit" disabled={userForm.pending} style={{ marginTop: 5 }}>
          {userForm.pending ? 'Saving...' : 'Add User'}
        </button>
      </form>

      <h2>Users ({users.length})</h2>
      {users.length ? (
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>ID</th>
              <th style={{ textAlign: 'left' }}>Name</th>
              <th style={{ textAlign: 'left' }}>Email</th>
              <th style={{ textAlign: 'left' }}>Active</th>
              <th style={{ textAlign: 'left' }}>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.id}</td>
                <td>{user.name}</td>
                <td>{user.email}</td>
                <td>{user.active ? 'Yes' : 'No'}</td>
                <td>{String(user.createdAt)}</td>
                <td>
                  <button type="button" onClick={() => deleteUser(user.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          <em>No users yet.</em>
        </p>
      )}

      <hr />

      <h2>Add Post</h2>
      <form action={postForm.post}>
        <div>
          <label>Title: </label>
          <input
            value={postForm.data.title}
            onChange={(e) => postForm.setData('title', e.target.value)}
            placeholder="Post title"
            required
          />
        </div>
        <div style={{ marginTop: 5 }}>
          <label>Body: </label>
          <input
            value={postForm.data.body}
            onChange={(e) => postForm.setData('body', e.target.value)}
            placeholder="Post body"
          />
        </div>
        <div style={{ marginTop: 5 }}>
          <label>Author: </label>
          <select
            value={postForm.data.authorId}
            onChange={(e) => postForm.setData('authorId', Number(e.target.value))}
            required
          >
            <option value={0} disabled>
              Select author
            </option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={postForm.pending} style={{ marginTop: 5 }}>
          {postForm.pending ? 'Saving...' : 'Add Post'}
        </button>
      </form>

      <h2>Posts ({posts.length})</h2>
      {posts.length ? (
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>ID</th>
              <th style={{ textAlign: 'left' }}>Title</th>
              <th style={{ textAlign: 'left' }}>Body</th>
              <th style={{ textAlign: 'left' }}>Author</th>
              <th style={{ textAlign: 'left' }}>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {posts.map((post) => (
              <tr key={post.id}>
                <td>{post.id}</td>
                <td>{post.title}</td>
                <td>{post.body}</td>
                <td>{post.author}</td>
                <td>{String(post.createdAt)}</td>
                <td>
                  <button type="button" onClick={() => deletePost(post.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          <em>No posts yet. Create a user first, then add a post.</em>
        </p>
      )}
    </div>
  );
}

// --- Type tests (compile-time only, never executed) ---
function _typeTests() {
  /* oxlint-disable react/rules-of-hooks -- These calls only exercise hook type signatures. */
  const userForm = useForm('/?create-user', { name: '', email: '' });
  const postForm = useForm('/?create-post', { title: '', body: '', authorId: 0 });

  // @ts-expect-error — invalid action name
  useForm('/?nonexistent-action', {});

  // @ts-expect-error — missing required field "email"
  useForm('/?create-user', { name: '' });

  // @ts-expect-error — extra field not in validator
  useForm('/?create-user', { name: '', email: '', bogus: true });

  // @ts-expect-error — wrong field type (name should be string)
  useForm('/?create-user', { name: 123, email: '' });

  // @ts-expect-error — wrong field type (authorId should be number)
  useForm('/?create-post', { title: '', body: '', authorId: 'not-a-number' });

  // @ts-expect-error — "bogus" is not a field on create-user body
  userForm.setData('bogus', 'value');

  // @ts-expect-error — name should be string, not number
  userForm.setData('name', 123);

  // @ts-expect-error — "authorId" doesn't exist on create-user form
  void userForm.data.authorId;

  // @ts-expect-error — "bogus" is not a field on create-post body
  postForm.setData('bogus', 'value');

  // @ts-expect-error — authorId should be number, not string
  postForm.setData('authorId', 'not-a-number');

  // @ts-expect-error — invalid action name
  void action('/?nonexistent-action', { data: {} });

  // @ts-expect-error — missing required field "id"
  void action('/?delete-user', { data: {} });

  // @ts-expect-error — wrong field type (id should be number)
  void action('/?delete-user', { data: { id: 'not-a-number' } });
  /* oxlint-enable react/rules-of-hooks */
}

void _typeTests;
