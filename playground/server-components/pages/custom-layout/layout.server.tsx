import type { CloudContext } from 'void';
import type { Child } from 'void/jsx';
import { SourceLink } from '../../components/SourceLink.tsx';

export default function GuideLayout(c: CloudContext, children: Child) {
  return (
    <section>
      <header>
        <p>
          <strong>Field Guide</strong> — custom layout
        </p>
        <p>
          Current path: <code>{c.req.path}</code>
        </p>
        <SourceLink file="pages/custom-layout/layout.server.tsx" />
      </header>
      <hr />
      <article>{children}</article>
      <hr />
      <footer>End of the field guide</footer>
    </section>
  );
}
