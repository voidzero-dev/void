import { getImageProps, Image } from '@void/react';
import { useState } from 'react';
import { Demo, Preview } from '../../src/demo.tsx';
import { lake, lakeAlt } from '../../src/photos.ts';

export default function QualityAndFormat() {
  const [quality, setQuality] = useState(75);
  const [accept, setAccept] = useState('image/avif,image/webp,image/jpeg');
  const [result, setResult] = useState('');
  const [pending, setPending] = useState(false);
  const common = { src: lake, alt: lakeAlt, width: 480, height: 320 };

  async function compareResponses() {
    setPending(true);
    const { props } = getImageProps({ ...common, quality });
    setResult(`Requesting quality ${quality}…`);
    try {
      const responses = await Promise.all(
        [props.src, lake].map(async (url) => {
          const response = await fetch(url, { headers: { Accept: accept } });
          const bytes = (await response.arrayBuffer()).byteLength;
          return `HTTP ${response.status} · ${response.headers.get('content-type')} · ${bytes.toLocaleString()} bytes`;
        }),
      );
      setResult(
        `Accept: ${accept}\nQuality: ${quality}\nOptimized: ${responses[0]}\nOriginal: ${responses[1]}`,
      );
    } catch (error) {
      setResult(String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Demo id="quality-and-format">
      <div className="controls">
        <label>
          Quality
          <select value={quality} onChange={(event) => setQuality(Number(event.target.value))}>
            <option value={40}>40</option>
            <option value={75}>75</option>
            <option value={90}>90</option>
          </select>
        </label>
        <label>
          Accept header for comparison
          <select value={accept} onChange={(event) => setAccept(event.target.value)}>
            <option value="image/avif,image/webp,image/jpeg">AVIF, WebP, JPEG</option>
            <option value="image/webp,image/jpeg">WebP, JPEG</option>
            <option value="image/jpeg">JPEG only</option>
          </select>
        </label>
        <button type="button" disabled={pending} onClick={compareResponses}>
          Compare responses
        </button>
      </div>
      <p>
        The comparison requests a fixed candidate. The previews below use the browser’s normal
        selection.
      </p>
      {result && <pre role="status">{result}</pre>}
      <Preview key={quality} label={`Optimized at quality ${quality}`}>
        <Image {...common} quality={quality} />
      </Preview>
      <Preview label="Original (unoptimized)">
        <Image {...common} unoptimized />
      </Preview>
    </Demo>
  );
}
