import { getImageProps } from '@void/react';
import { Demo, Preview } from '../../src/demo.tsx';
import { lake, lakeAlt, portrait } from '../../src/photos.ts';

export default function ArtDirection() {
  const common = { alt: lakeAlt, sizes: '(max-width: 800px) 90vw, 60vw' };
  const { props: wide } = getImageProps({ ...common, src: lake, width: 1440, height: 960 });
  const { props: tall } = getImageProps({ ...common, src: portrait, width: 720, height: 960 });

  return (
    <Demo id="art-direction">
      <Preview label="Landscape on wide screens, portrait on narrow screens">
        <picture>
          <source
            media="(min-width: 800px)"
            srcSet={wide.srcSet}
            sizes={wide.sizes}
            width={1440}
            height={960}
          />
          <img {...tall} />
        </picture>
      </Preview>
    </Demo>
  );
}
