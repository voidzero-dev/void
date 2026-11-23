import { Image } from '@void/react';
import { useState } from 'react';
import { Demo, Preview } from '../../src/demo.tsx';
import { lake, lakeAlt } from '../../src/photos.ts';

export default function ResponsiveSizing() {
  const [mode, setMode] = useState('fixed');
  return (
    <Demo id="responsive-sizing">
      <div className="controls">
        <label>
          Image mode
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="fixed">Fixed width</option>
            <option value="fill">Fill the container</option>
          </select>
        </label>
      </div>
      <Preview key={mode} label={mode === 'fixed' ? 'Fixed width: 320 px' : 'Fill with sizes'}>
        {mode === 'fixed' ? (
          <Image src={lake} alt={lakeAlt} width={320} height={213} />
        ) : (
          <div className="fill-frame">
            <Image
              src={lake}
              alt={lakeAlt}
              fill
              sizes="(max-width: 800px) 90vw, 60vw"
              style={{ objectFit: 'cover' }}
            />
          </div>
        )}
      </Preview>
    </Demo>
  );
}
