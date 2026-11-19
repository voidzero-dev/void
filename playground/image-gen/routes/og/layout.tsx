/** @jsxImportSource void/jsx */
import { defineHandler } from 'void';
import { previewImage, selectRenderer } from '../../src/renderer.server.ts';

export const GET = defineHandler((c) =>
  previewImage(
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        alignItems: 'center',
        gap: 48,
        padding: 64,
        color: '#fff',
        background: 'linear-gradient(135deg, #1e1b4b, #2563eb)',
      }}
    >
      <div style={{ display: 'flex', flex: 1, flexDirection: 'column', gap: 24 }}>
        <div style={{ fontSize: 30, color: '#bfdbfe' }}>VOID / LAYOUT</div>
        <div style={{ fontSize: 72, fontWeight: 700 }}>Small markup. Big preview.</div>
        <div style={{ fontSize: 30 }}>Inline CSS inside the image.</div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          borderRadius: 24,
          padding: 40,
          background: '#ffffff22',
          color: '#1e1b4b',
          fontSize: 36,
          fontWeight: 700,
        }}
      >
        <div style={{ borderRadius: 12, padding: 24, background: '#fff' }}>Vite</div>
        <div style={{ borderRadius: 12, padding: 24, background: '#bfdbfe' }}>Void</div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      renderer: selectRenderer(c.req.query('renderer')),
      debug: c.req.query('debug') === 'on',
    },
  ),
);
