import { Image } from '@void/react';
import importedLake from '../../assets/lake.jpg?image';
import { Demo, Preview } from '../../src/demo.tsx';
import { lake, lakeAlt } from '../../src/photos.ts';

export default function LocalImages() {
  return (
    <Demo id="local-images">
      <Preview label="Public URL — explicit dimensions">
        <Image
          src={lake}
          alt={lakeAlt}
          width={1440}
          height={960}
          sizes="(max-width: 800px) 90vw, 60vw"
        />
      </Preview>
      <Preview label={`?image import — ${importedLake.width} × ${importedLake.height}`}>
        <Image src={importedLake} alt={lakeAlt} sizes="(max-width: 800px) 90vw, 60vw" />
      </Preview>
    </Demo>
  );
}
