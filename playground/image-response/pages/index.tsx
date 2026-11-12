import { Link } from '@void/react';
import { examples } from '../src/examples.ts';
import { SourceLink } from '../src/source-link.tsx';

export default function Home() {
  return (
    <>
      <h1>ImageResponse Playground</h1>
      <p>
        Eight distinct uses of <code>ImageResponse</code> from <code>void/image</code>. Each example
        has a live preview, source links, and expected results. Options that exercise the same use
        case stay together on one page.
      </p>
      <p>
        Start with the JSX or HTML examples for an offline baseline. Fonts, multilingual text,
        emoji, and remote images also exercise server-side downloads. Use the Network panel and
        server log alongside the previews.
      </p>
      <div className="examples">
        {examples.map((example) => (
          <section className="example" key={example.id}>
            <h2>
              <Link href={`/examples/${example.id}`}>{example.title}</Link>
            </h2>
            <p>{example.description}</p>
            <SourceLink file={example.file} />
            <pre>{example.code}</pre>
            <p>
              <Link href={`/examples/${example.id}`}>Open demo</Link>
            </p>
          </section>
        ))}
      </div>
    </>
  );
}
