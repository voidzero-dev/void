import { defer, defineHandler, defineHead, type InferServerProps } from 'void';
import { SourceLink } from '../../../components/SourceLink.tsx';

export const prerender = true;

const posts = new Map([
  ['42', 'A post whose title and description resolve before rendering.'],
  ['43', 'Another post included in the static build.'],
]);

export function getPrerenderPaths(): Array<{ id: string }> {
  return Array.from(posts.keys(), (id) => ({ id }));
}

export const loader = defineHandler((c) => {
  const id = c.req.param('id');
  if (id === 'latest') {
    return c.redirect('/posts/42');
  }
  const description = posts.get(id ?? '');
  if (!description) {
    return c.notFound();
  }
  return {
    title: defer(async () => `Post ${id}`),
    description: defer(async () => description),
  };
});

type Props = InferServerProps<typeof loader>;

export const head = defineHead<Props>((_c, { title, description }) => ({
  title,
  meta: [{ name: 'description', content: description }],
}));

export default function Page({ title, description }: Props) {
  return (
    <>
      <h1>{title}</h1>
      <SourceLink file="pages/posts/[id]/index.server.tsx" />
      <p>{description}</p>
      <p>View source to find the title and meta description in the initial HTML.</p>
      <p>
        <a href="/posts">Compare post layouts</a>
      </p>
    </>
  );
}
