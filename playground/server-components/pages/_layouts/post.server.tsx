import type { CloudContext } from 'void';
import type { Child } from 'void/jsx';

export default function PostLayout(_c: CloudContext, children: Child) {
  return (
    <section>
      <p>
        <strong>Post layout</strong>
      </p>
      {children}
      <a href="/">Back to the playground</a>
    </section>
  );
}
