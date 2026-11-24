/** @jsxImportSource void/jsx */
import { defineHandler } from 'void';
import { Card } from '../../src/card.tsx';
import { previewImage, selectRenderer } from '../../src/renderer.server.ts';

export const GET = defineHandler((c) =>
  previewImage(
    <Card>
      <div style={{ fontSize: 30, color: '#38bdf8' }}>A DIFFERENT FORMAT</div>
      <div style={{ fontSize: 80, fontWeight: 700 }}>Think outside the rectangle.</div>
      <div style={{ fontSize: 30 }}>600 x 600</div>
    </Card>,
    {
      width: 600,
      height: 600,
      renderer: selectRenderer(c.req.query('renderer')),
      headers: { 'Cache-Control': 'no-store', 'X-OG-Demo': 'square' },
    },
  ),
);
