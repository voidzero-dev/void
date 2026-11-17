import { SourceLink } from '../../components/SourceLink.tsx';

export const layout = 'post';

export default function LayoutExample() {
  return (
    <>
      <h1>Named layout replacement</h1>
      <SourceLink file="pages/posts/layout-example.server.tsx" />
      <p>The root navigation stays. The named post layout replaces only the nested posts layout.</p>
      <p>
        <a href="/posts">Compare with the default nested layout</a>
      </p>
    </>
  );
}
