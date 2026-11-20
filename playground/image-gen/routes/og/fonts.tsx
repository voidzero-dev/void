/** @jsxImportSource void/jsx */
import { defineHandler } from 'void';
import type { BrowserRunFontData, ImageFont } from 'void/image';
import { Card } from '../../src/card.tsx';
import { getFontPreset } from '../../src/fonts.ts';
import { previewImage, selectRenderer } from '../../src/renderer.server.ts';

export const GET = defineHandler(async (c) => {
  const renderer = selectRenderer(c.req.query('renderer'));
  const font = getFontPreset(c.req.query('font'));
  const mode = c.req.query('mode');
  const source = renderer || mode === 'url' || mode === 'data' ? font.google : undefined;
  let fonts: Array<ImageFont<string, BrowserRunFontData>> | undefined;
  if (source) {
    const response = await Promise.all(
      source.files.map(async ({ url, weight }) => {
        if (!renderer && mode !== 'data') {
          return { name: source.family, data: { url }, weight };
        }
        const response = await fetch(url);
        return response.ok
          ? { name: source.family, data: await response.arrayBuffer(), weight }
          : null;
      }),
    );
    if (response.some((file) => file === null)) {
      return c.text('Could not download the demo font.', 502);
    }
    fonts = response.filter((file) => file !== null);
  }
  const family = source ? source.family : renderer ? undefined : font.family;
  const webdings = !renderer && font.id === 'webdings';
  return previewImage(
    <Card>
      <div style={{ fontSize: 26, color: '#38bdf8' }}>
        {font.family.toUpperCase()} / {source?.family ?? (renderer ? 'Roboto' : 'BROWSER RUN')}
      </div>
      {[400, 550, 700].map((weight) => (
        <div key={weight} style={{ fontSize: 66, fontWeight: weight, fontFamily: family }}>
          {webdings ? 'ABCDEFGHIJKLM' : `${weight} — Build with Void`}
        </div>
      ))}
    </Card>,
    {
      width: 1200,
      height: 630,
      renderer: renderer && [renderer, { fallbackFonts: false }],
      fonts,
    },
  );
});
