import { defineHandler, type InferProps } from 'void';
import { SourceLink } from '../components/SourceLink.tsx';

export const loader = defineHandler((c) => ({ name: c.req.query('name') || 'world' }));

export default function Greeting({ name }: InferProps<typeof loader>) {
  return (
    <>
      <h1>Render a page with a loader</h1>
      <SourceLink file="pages/greeting.server.tsx" />
      <p>Hello, {name}!</p>
      <form method="get" action="/greeting">
        <label>
          Name <input name="name" value={name} />
        </label>{' '}
        <button type="submit">Update greeting</button>
      </form>
      <p>
        Try entering <code>{'<reader>'}</code> as the name to see it rendered as text.
      </p>
    </>
  );
}
