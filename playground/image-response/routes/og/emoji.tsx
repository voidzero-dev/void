import { defineHandler } from 'void';
import { ImageResponse, type ImageResponseOptions } from 'void/image';
import { Card } from '../../src/card.tsx';

const styles = ['twemoji', 'blobmoji', 'noto', 'openmoji', 'fluent', 'fluentFlat'] as const;

export const GET = defineHandler((c) => {
  const requested = c.req.query('emoji');
  const emoji: ImageResponseOptions['emoji'] =
    styles.find((style) => style === requested) ?? 'twemoji';
  return new ImageResponse(
    <Card>
      <div style={{ fontSize: 30, color: '#38bdf8' }}>EMOJI / {emoji}</div>
      <div style={{ fontSize: 68, fontWeight: 700 }}>Ship something great 🚀</div>
      <div style={{ fontSize: 108 }}>
        {c.req.query('sample') === 'joined' ? '👩‍💻 🎉 🌍 ❤️' : '😀 🎉 🌍 ❤️'}
      </div>
    </Card>,
    { width: 1200, height: 630, emoji, images: { timeout: 5000 } },
  );
});
