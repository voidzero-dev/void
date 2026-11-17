import { ImageResponse } from '@void/image/generate';
import { defineHandler } from 'void';
import { html } from 'void/html';

export const GET = defineHandler(
  () =>
    new ImageResponse(
      html`<div style="display: flex; font-size: 16px; background: #F48120"></div>`,
      {
        width: 64,
        height: 64,
        fallbackFonts: false,
        headers: { 'Cache-Control': 'no-store' },
      },
    ),
);
