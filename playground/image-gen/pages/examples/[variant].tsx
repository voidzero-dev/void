import { useEffect, useState } from 'react';
import { getExample, getExamplePreview, type Control } from '../../src/examples.ts';
import { getFontPreset, googleFontPage } from '../../src/fonts.ts';
import { RendererSelect } from '../../src/renderer-select.tsx';
import { SourceLink } from '../../src/source-link.tsx';
import type { Props } from './[variant].server.ts';

function SelectOptions({ options }: { options: NonNullable<Control['options']> }) {
  const groups = new Map<string, typeof options>();
  for (const option of options) {
    const group = option.group ?? '';
    const entries = groups.get(group) ?? [];
    entries.push(option);
    groups.set(group, entries);
  }
  return Array.from(groups, ([group, entries]) => {
    const items = entries.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ));
    return group ? (
      <optgroup key={group} label={group}>
        {items}
      </optgroup>
    ) : (
      items
    );
  });
}

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

export default function ExamplePage({ variant, values, renderer, imageUrl }: Props) {
  const example = getExample(variant)!;
  const preview = getExamplePreview(example, renderer);
  const font = variant === 'fonts' ? getFontPreset(values.font) : undefined;
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
      <pre>{preview.code}</pre>
      {preview.network && (
        <p className="notice">
          <strong>Network:</strong> {preview.network}
        </p>
      )}
      {example.takumiOnly && (
        <p className="notice">
          Takumi only. Browser Run can load remote images, but it does not expose these image
          download controls.
        </p>
      )}
      <form key={`${variant}:${imageUrl}`} method="get" className="controls">
        {!example.takumiOnly && <RendererSelect renderer={renderer} />}
        {preview.controls.map((control) => (
          <label key={control.name}>
            {control.label}
            {control.options ? (
              <select
                name={control.name}
                defaultValue={values[control.name]}
                onChange={(event) => event.currentTarget.form?.requestSubmit()}
              >
                <SelectOptions options={control.options} />
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
      {font && (
        <p className="notice">
          Browser Run built-in: <strong>{font.family}</strong>. Google Fonts:{' '}
          {font.google ? (
            <>
              <a href={googleFontPage(font.google.family)}>{font.google.family} on Google Fonts</a>
              {font.google.family !== font.family ? ' (substitute)' : ' (exact match)'}.
            </>
          ) : (
            'No equivalent (Takumi uses Roboto).'
          )}
        </p>
      )}
      {renderer === 'browser' && (
        <p className="notice">
          {variant === 'emoji'
            ? 'Browser Run does not natively support custom emoji sets. The Twemoji and OpenMoji options use SVG images supplied by this example.'
            : 'Browser Run uses browser emoji. Image download limits in these examples only apply to Takumi.'}{' '}
          Browser Run requires a connected Cloudflare account in local development.
        </p>
      )}
      <div className="demo">
        <Preview key={imageUrl} imageUrl={imageUrl} title={example.title} />
        <section>
          <h2>Expected</h2>
          <ul>
            {preview.checks.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
          {variant === 'emoji' && renderer === 'browser' && (
            <p>
              Artwork: <a href="https://github.com/jdecked/twemoji">Twemoji</a> by Twitter and
              contributors (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)
              and <a href="https://openmoji.org/">OpenMoji</a> (
              <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>).
            </p>
          )}
          <p>All images are 1200 × 630 unless the demo explicitly sets a different size.</p>
          <p>
            <SourceLink file="pages/examples/[variant].server.ts" /> (loader and page head)
          </p>
        </section>
      </div>
    </>
  );
}
