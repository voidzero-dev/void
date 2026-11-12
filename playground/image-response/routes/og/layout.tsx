import { defineHandler } from 'void';
import { ImageResponse } from 'void/og';

export const GET = defineHandler(
  (c) =>
    new ImageResponse(
      <div
        tw="flex h-full w-full items-center gap-12 p-16 text-white"
        style={{ background: 'linear-gradient(135deg, #1e1b4b, #2563eb)' }}
      >
        <div tw="flex flex-1 flex-col gap-6">
          <div tw="text-3xl text-blue-200">VOID / LAYOUT</div>
          <div tw="text-7xl font-bold">Small markup. Big preview.</div>
          <div tw="text-3xl">Tailwind classes inside the image.</div>
        </div>
        <div tw="flex flex-col gap-6 rounded-3xl p-10" style={{ background: '#ffffff22' }}>
          <div tw="rounded-xl bg-white p-6 text-4xl font-bold text-indigo-950">Vite</div>
          <div tw="rounded-xl bg-blue-200 p-6 text-4xl font-bold text-indigo-950">Void</div>
        </div>
      </div>,
      { debug: c.req.query('debug') === 'on' },
    ),
);
