import { Link } from '@void/react';
import { examples } from '../src/examples.ts';
import { RendererSelect } from '../src/renderer-select.tsx';
import { SourceLink } from '../src/source-link.tsx';
import type { Props } from './index.server.ts';

export default function Home({ renderer }: Props) {
  return (
    <>
      <h1>ImageResponse Playground</h1>
      <form key={renderer} method="get" className="controls">
        <RendererSelect renderer={renderer} />
      </form>
      <p>
        <Link href="/font-memory">Font cache memory reproduction</Link> — load distinct fonts into
        one family and watch server memory.
      </p>
      <p>
        Eight distinct uses of <code>ImageResponse</code> from <code>void/image</code>. Each example
        has a live preview, source links, and expected results. Options that exercise the same use
        case stay together on one page.
      </p>
      <p>
        With Takumi, start with the JSX or HTML examples for an offline baseline. Fonts,
        multilingual text, emoji, and remote images also exercise server-side downloads. Use the
        Network panel and server log alongside the previews.
      </p>
      <div className="examples">
        {examples.map((example) => {
          const demoRenderer = example.takumiOnly ? 'takumi' : renderer;
          const href = `/examples/${example.id}?renderer=${demoRenderer}`;
          return (
            <section className="example" key={example.id}>
              <h2>
                <Link href={href}>{example.title}</Link>
              </h2>
              <p>{example.description}</p>
              <SourceLink file={example.file} />
              <pre>{example.code}</pre>
              <p>
                <Link href={href}>
                  {example.takumiOnly ? 'Open Takumi-only demo' : 'Open demo'}
                </Link>
              </p>
            </section>
          );
        })}
      </div>
    </>
  );
}
