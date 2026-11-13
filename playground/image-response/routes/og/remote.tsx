import { defineHandler } from 'void';
import { ImageResponse } from 'void/image';
import { Card } from '../../src/card.tsx';

// Fixed input: this demo never accepts arbitrary remote URLs from a request.
const avatar = 'https://avatars.githubusercontent.com/u/65625612?s=256';

export const GET = defineHandler((c) => {
  const mode = c.req.query('mode') ?? 'allow';
  return new ImageResponse(
    <Card>
      <div style={{ fontSize: 28, color: '#38bdf8' }}>REMOTE IMAGE / {mode}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 48 }}>
        <img src={avatar} width={240} height={240} style={{ borderRadius: 40 }} />
        <div style={{ fontSize: 64, fontWeight: 700 }}>An image from the web.</div>
      </div>
      <div style={{ fontSize: 28 }}>The text survives a lenient image failure.</div>
    </Card>,
    {
      width: 1200,
      height: 630,
      images: {
        allowUrl: (url) => url === avatar && (mode === 'allow' || mode === 'limit'),
        maxBytes: mode === 'limit' ? 64 : 1024 * 1024,
        timeout: 5000,
        throwOnError: mode === 'allow' || mode === 'fail',
      },
    },
  );
});
