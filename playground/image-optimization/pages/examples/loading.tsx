import { Image } from '@void/react';
import placeholder from '../../assets/lake-placeholder.jpg?inline';
import { Demo, Preview } from '../../src/demo.tsx';
import { lake, lakeAlt, portrait } from '../../src/photos.ts';

export default function Loading() {
  return (
    <Demo id="loading">
      <div>
        <Preview label="Preloaded hero">
          <Image
            src={lake}
            alt={lakeAlt}
            width={1440}
            height={960}
            preload
            sizes="(max-width: 800px) 90vw, 60vw"
          />
        </Preview>
        <div className="loading-gap" aria-hidden="true" />
        <p className="loading-hint">Scroll to bring the lazy image into range ↓</p>
      </div>
      <Preview label="Lazy image with a blur placeholder">
        <Image
          src={portrait}
          alt={lakeAlt}
          width={720}
          height={960}
          loading="lazy"
          placeholder="blur"
          blurDataURL={placeholder}
          sizes="(max-width: 800px) 90vw, 60vw"
        />
      </Preview>
    </Demo>
  );
}
