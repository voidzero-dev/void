import { Image } from '@void/react';
import { useState } from 'react';
import { Demo, Preview, SourceLink } from '../../src/demo.tsx';
import { lakeAlt, remoteImage } from '../../src/photos.ts';

export default function RemoteImages() {
  const [status, setStatus] = useState('');
  const rejected = new URLSearchParams({ url: `${remoteImage}&demo=denied`, w: '640', q: '75' });

  async function tryRejectedUrl() {
    setStatus('Requesting…');
    try {
      const response = await fetch(`/_void/image?${rejected}`);
      setStatus(`HTTP ${response.status}: ${await response.text()}`);
    } catch (error) {
      setStatus(String(error));
    }
  }

  return (
    <Demo id="remote-images">
      <Preview label="Allowed remote source (requires internet access)">
        <Image
          src={remoteImage}
          alt={lakeAlt}
          width={1440}
          height={960}
          sizes="(max-width: 800px) 90vw, 60vw"
        />
      </Preview>
      <p>
        See the exact URL allowlist in <SourceLink file="void.config.ts" />.
      </p>
      <button type="button" onClick={tryRejectedUrl}>
        Try a URL outside the allowlist
      </button>
      <p role="status">{status}</p>
    </Demo>
  );
}
