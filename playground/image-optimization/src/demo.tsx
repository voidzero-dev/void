import { useEffect, useRef, useState, type ReactNode } from 'react';
import { examples, type ExampleId } from './examples.ts';

declare const __IMAGE_OPTIMIZATION_SOURCE_ROOT__: string;

export function SourceLink({ file }: { file: string }) {
  const source = new URL(file, __IMAGE_OPTIMIZATION_SOURCE_ROOT__);
  return (
    <a href={`vscode://file${source.pathname}:1:1`} title={`Open ${file} in VS Code`}>
      <code>{file}</code>
    </a>
  );
}

export function Demo({ id, children }: { id: ExampleId; children: ReactNode }) {
  const example = examples[id];
  return (
    <>
      <h1>{example.title}</h1>
      <p>{example.description}</p>
      <div className="demo">
        <section aria-label="Live preview">{children}</section>
        <aside>
          <h2>What to look for</h2>
          <p>{example.expected}</p>
          <h2>Source</h2>
          <SourceLink file={`pages/examples/${id}.tsx`} />
          <pre>
            <code>{example.code}</code>
          </pre>
        </aside>
      </div>
    </>
  );
}

export function Preview({ label, children }: { label: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState('');

  useEffect(() => {
    const image = frame.current?.querySelector('img');
    if (!image) {
      return;
    }
    const update = () => {
      if (!image.complete || !image.naturalWidth) {
        return;
      }
      const url = new URL(image.currentSrc);
      const candidate = url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
      setInfo(`${Math.round(image.getBoundingClientRect().width)} CSS px · ${candidate}`);
    };
    const fail = () => setInfo('Image failed to load. Inspect the request in the Network panel.');
    const observer = new ResizeObserver(update);
    observer.observe(image);
    image.addEventListener('load', update);
    image.addEventListener('error', fail);
    if (image.complete && image.currentSrc && !image.naturalWidth) {
      fail();
    } else {
      update();
    }
    return () => {
      observer.disconnect();
      image.removeEventListener('load', update);
      image.removeEventListener('error', fail);
    };
  }, []);

  return (
    <figure>
      <div ref={frame} className="preview">
        {children}
      </div>
      <figcaption>
        <strong>{label}</strong>
        <br />
        <code>{info || 'Waiting for the image…'}</code>
      </figcaption>
    </figure>
  );
}
