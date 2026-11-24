import { SourceLink } from '../components/SourceLink.tsx';

export const layout = '!post';

export default function ExclusiveLayoutExample() {
  return (
    <>
      <h1>Replace the whole layout chain</h1>
      <SourceLink file="pages/exclusive-layout.server.tsx" />
      <p>
        With <code>layout = '!post'</code>, only the named post layout wraps this page. The root
        navigation is gone.
      </p>
      <p>
        <a href="/posts/layout-example">Compare replacing just the innermost layout</a>
      </p>
    </>
  );
}
