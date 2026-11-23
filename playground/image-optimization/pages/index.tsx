import { Link } from '@void/react';
import { SourceLink } from '../src/demo.tsx';
import { examples } from '../src/examples.ts';

export default function Home() {
  return (
    <>
      <h1>Image Optimization Playground</h1>
      <p>
        Six examples of <code>Image</code>, <code>getImageProps()</code>, and the Void image
        optimizer. Each demo has a live preview, source links, and something to look for in the
        browser. Start with local images, then open the Network panel to inspect the requests.
      </p>
      <div className="examples">
        {Object.entries(examples).map(([id, example]) => {
          const href = `/examples/${id}`;
          return (
            <section className="example" key={id}>
              <h2>
                <Link href={href}>{example.title}</Link>
              </h2>
              <p>{example.description}</p>
              <SourceLink file={`pages/examples/${id}.tsx`} />
              <pre>
                <code>{example.code}</code>
              </pre>
              <p>
                <Link href={href}>Open {example.title.toLowerCase()} demo</Link>
              </p>
            </section>
          );
        })}
      </div>
    </>
  );
}
