import { defineHandler } from 'void';
import { ImageResponse } from 'void/image';
import { Card } from '../../src/card.tsx';

export const GET = defineHandler(
  () =>
    new ImageResponse(
      <Card>
        <div style={{ fontSize: 30, color: '#38bdf8' }}>A DIFFERENT FORMAT</div>
        <div style={{ fontSize: 80, fontWeight: 700 }}>Think outside the rectangle.</div>
        <div style={{ fontSize: 30 }}>600 x 600</div>
      </Card>,
      { width: 600, height: 600, headers: { 'Cache-Control': 'no-store', 'X-OG-Demo': 'square' } },
    ),
);
