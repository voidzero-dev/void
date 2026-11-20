import { defer, defineHandler, defineHead, type InferServerProps } from 'void';
import { SourceLink } from '../components/SourceLink.tsx';

export const prerender = false;

export const action = defineHandler(async (c) => {
  const draft = (await c.req.formData()).get('title');
  if (typeof draft === 'string') {
    c.set('draftTitle', draft.trim().slice(0, 80));
  }
});

export const loader = defineHandler((c) => {
  // The action and loader share this request's context, not any persistent storage.
  const draft = c.get('draftTitle');
  const title = (typeof draft === 'string' && draft) || 'Untitled draft';
  return { title: defer(async () => title) };
});

type Props = InferServerProps<typeof loader>;

export const head = defineHead<Props>((_c, { title }) => ({ title }));

export default function Preview({ title }: Props) {
  return (
    <>
      <h1>{title}</h1>
      <SourceLink file="pages/preview.server.tsx" />
      <p>Submit a draft title to update this heading and the browser tab. Nothing is saved.</p>
      <form method="post" action="/preview">
        <label>
          Draft title <input name="title" value={title} maxlength={80} required />
        </label>{' '}
        <button type="submit">Preview draft</button>
      </form>
    </>
  );
}
