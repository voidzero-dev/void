import { useIslandForm } from '@void/hono';

export default function PostForm() {
  const form = useIslandForm({ title: '', body: '' });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        return form.post('/blog');
      }}
    >
      <div>
        <label for="title">Title:</label>
        <input
          id="title"
          value={form.data.title}
          onInput={(e) => form.setData('title', (e.target as HTMLInputElement).value)}
        />
        {form.errors.title && <span style={{ color: 'red' }}>{form.errors.title}</span>}
      </div>
      <div>
        <label for="body">Body:</label>
        <textarea
          id="body"
          value={form.data.body}
          onInput={(e) => form.setData('body', (e.target as HTMLTextAreaElement).value)}
        />
        {form.errors.body && <span style={{ color: 'red' }}>{form.errors.body}</span>}
      </div>
      <button type="submit" disabled={form.pending}>
        {form.pending ? 'Saving...' : 'Add Post'}
      </button>
    </form>
  );
}
