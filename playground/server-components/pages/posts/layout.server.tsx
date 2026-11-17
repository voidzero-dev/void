import type { CloudContext } from 'void';
import type { Child } from 'void/jsx';

export default function Layout(_c: CloudContext, children: Child) {
  return (
    <section>
      <p>
        <strong>Nested posts layout</strong>
      </p>
      {children}
    </section>
  );
}
