import { defineHandler } from 'void';
import { html } from 'void/html';
import { ImageResponse } from 'void/image';

export const GET = defineHandler((c) => {
  const title = (c.req.query('title') ?? 'Hello without JSX').slice(0, 200);
  return new ImageResponse(
    html`
      <div
        style="display: flex; flex-direction: column; justify-content: center; gap: 32px;
      width: 100%; height: 100%; padding: 72px; background: #ecfdf5; color: #064e3b"
      >
        <div style="font-size: 28px">HTML template, not React</div>
        <div style="font-size: 64px; font-weight: 700">${title}</div>
      </div>
    `,
    { width: 1200, height: 630 },
  );
});
