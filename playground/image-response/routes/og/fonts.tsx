import { defineHandler } from 'void';
import { ImageResponse, type ImageResponseOptions } from 'void/image';
import { Card } from '../../src/card.tsx';
import { fontPresets } from '../../src/fonts.ts';

export const GET = defineHandler(async (c) => {
  const font = fontPresets.find((preset) => preset.id === c.req.query('font')) ?? fontPresets[0]!;
  let fonts: ImageResponseOptions['fonts'] = [font.url];
  if (c.req.query('mode') === 'data') {
    const response = await fetch(font.url);
    if (!response.ok) {
      return c.text('Could not download the demo font.', 502);
    }
    // No weight: the variable font follows each element's fontWeight.
    fonts = [{ name: font.name, data: await response.arrayBuffer() }];
  }
  return new ImageResponse(
    <Card>
      <div style={{ fontSize: 26, color: '#38bdf8' }}>
        {font.name.toUpperCase()} / VARIABLE WEIGHTS
      </div>
      {[400, 550, 700].map((weight) => (
        <div key={weight} style={{ fontSize: 66, fontWeight: weight }}>
          {weight} — Build with Void
        </div>
      ))}
    </Card>,
    { width: 1200, height: 630, fonts, fallbackFonts: false },
  );
});
