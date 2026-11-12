import { useEffect, useState } from 'react';
import { getExample } from '../../src/examples.ts';
import { SourceLink } from '../../src/source-link.tsx';
import type { Props } from './[variant].server.ts';

function Preview({ imageUrl, title }: { imageUrl: string; title: string }) {
  const [imageSrc, setImageSrc] = useState<string>();
  const [size, setSize] = useState('Loading image…');
  const [responseInfo, setResponseInfo] = useState('Fetching image…');

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;

    async function load() {
      let info = '';
      try {
        const response = await fetch(imageUrl, { cache: 'no-store', signal: controller.signal });
        info = [
          `HTTP ${response.status}`,
          ...Array.from(response.headers, ([k, v]) => `${k}: ${v}`),
        ].join('\n');
        setResponseInfo(info);
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) {
          return;
        }
        info += `\n\nBody: ${bytes.byteLength.toLocaleString()} bytes`;
        const png = new DataView(bytes);
        if (
          !response.ok ||
          bytes.byteLength < 24 ||
          png.getUint32(0) !== 0x89504e47 ||
          png.getUint32(4) !== 0x0d0a1a0a
        ) {
          info += `\n\n${new TextDecoder().decode(bytes.slice(0, 2000))}`;
          throw new Error(
            response.ok ? 'The response body is not a PNG.' : `HTTP ${response.status}`,
          );
        }
        info += `\nPNG: ${png.getUint32(16)} × ${png.getUint32(20)}`;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        setImageSrc(objectUrl);
        setResponseInfo(info);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setSize('Image failed to load. See the response below and server log.');
        setResponseInfo(`${info}\n\nImage request/body failed: ${String(error)}`.trim());
      }
    }

    void load();
    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [imageUrl]);

  return (
    <section aria-label="Image preview">
      <div className="preview">
        {imageSrc && (
          <img
            src={imageSrc}
            alt={title}
            onLoad={(event) =>
              setSize(
                `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight} PNG`,
              )
            }
            onError={() =>
              setSize('Image could not be decoded. See the response below and server log.')
            }
          />
        )}
      </div>
      <p role="status">{size}</p>
      <p>
        <a href={imageSrc ?? imageUrl}>Open PNG</a> |{' '}
        <a href={imageSrc ?? imageUrl} download={`${title}.png`}>
          Download PNG
        </a>
      </p>
      <p>
        <code>{imageUrl}</code>
      </p>
      <h2>Response</h2>
      <pre role="status">{responseInfo}</pre>
    </section>
  );
}

export default function ExamplePage({ variant, values, imageUrl }: Props) {
  const example = getExample(variant)!;
  return (
    <>
      <h1>{example.title}</h1>
      <p>{example.description}</p>
      <p>
        <SourceLink file={example.file} />
      </p>
      {variant === 'article' && (
        <p>
          <SourceLink file="src/card.tsx" /> |{' '}
          <a href="/og/article/missing">Missing article (404)</a>
        </p>
      )}
      <pre>{example.code}</pre>
      {example.network && (
        <p className="notice">
          <strong>Network:</strong> {example.network}
        </p>
      )}
      {example.controls.length > 0 && (
        <form key={`${variant}:${imageUrl}`} method="get" className="controls">
          {example.controls.map((control) => (
            <label key={control.name}>
              {control.label}
              {control.options ? (
                <select
                  name={control.name}
                  defaultValue={values[control.name]}
                  onChange={(event) => event.currentTarget.form?.requestSubmit()}
                >
                  {control.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={control.name}
                  defaultValue={values[control.name]}
                  maxLength={200}
                  onBlur={(event) => {
                    if (event.currentTarget.value !== values[control.name]) {
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
              )}
            </label>
          ))}
        </form>
      )}
      <div className="demo">
        <Preview key={imageUrl} imageUrl={imageUrl} title={example.title} />
        <section>
          <h2>Expected</h2>
          <ul>
            {example.checks.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
          <p>All images are 1200 × 630 unless the demo explicitly sets a different size.</p>
          <p>
            <SourceLink file="pages/examples/[variant].server.ts" /> (loader and page head)
          </p>
        </section>
      </div>
    </>
  );
}
