import { Image } from '@void/react';
import staticImage from '../src/void-image-static.png?image';

export default function ImagePage() {
  return (
    <main>
      <h1>Image</h1>
      <Image
        src="/void-image-test.png"
        alt="Void image test"
        width={640}
        height={320}
        data-testid="image-fixed"
      />
      <Image
        src="/void-image-test.png"
        alt="Void image preload"
        width={320}
        height={160}
        preload
        data-testid="image-preload"
      />
      <div
        data-testid="image-fill-container"
        style={{ position: 'relative', width: '300px', height: '150px' }}
      >
        <Image
          src="/void-image-test.png"
          alt="Void image fill"
          fill
          sizes="300px"
          data-testid="image-fill"
        />
      </div>
      <Image src={staticImage} alt="Void image static import" data-testid="image-static" />
    </main>
  );
}
