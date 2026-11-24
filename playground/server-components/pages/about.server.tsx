import { SourceLink } from '../components/SourceLink.tsx';

export const layout = false;
export const prerender = false;

export function head() {
  return { title: 'About | Server Components' };
}

export default function Page() {
  return (
    <main>
      <h1>About this playground</h1>
      <SourceLink file="pages/about.server.tsx" />
      <p>
        No loader and no layout. This page doesn’t need the request context, so it takes no
        arguments.
      </p>
      <p>This page opts out of static generation.</p>
      <a href="/">Back to the playground</a>
    </main>
  );
}
