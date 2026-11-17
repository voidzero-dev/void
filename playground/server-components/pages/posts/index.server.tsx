import { SourceLink } from '../../components/SourceLink.tsx';

export default function Posts() {
  return (
    <>
      <h1>Posts</h1>
      <SourceLink file="pages/posts/index.server.tsx" />
      <p>This page inherits both the root navigation and the nested posts layout.</p>
      <ul>
        <li>
          <a href="/posts/layout-example">Replace only the nested layout</a>
        </li>
        <li>
          <a href="/exclusive-layout">Replace the whole layout chain</a>
        </li>
        <li>
          <a href="/posts/latest">Redirect to Post 42</a>
        </li>
        <li>
          <a href="/posts/missing">Request a missing post</a>
        </li>
      </ul>
    </>
  );
}
