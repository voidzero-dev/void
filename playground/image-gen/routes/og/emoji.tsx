/** @jsxImportSource void/jsx */
import { defineHandler } from 'void';
import { Card } from '../../src/card.tsx';
import { getBrowserEmojiStyle, takumiEmojiStyles } from '../../src/emoji-styles.ts';
import { previewImage, selectRenderer } from '../../src/renderer.server.ts';

const sampleGlyphs = ['😀', '👩‍💻', '🎉', '🌍', '❤️'] as const;
type DemoGlyph = (typeof sampleGlyphs)[number] | '🚀';

// Fixed demo glyphs only. Keep the ZWJ sequence intact and omit the heart's
// variation selector, which isn't part of either asset filename.
const assetCodes: Record<DemoGlyph, string> = {
  '😀': '1f600',
  '👩‍💻': '1f469-200d-1f4bb',
  '🎉': '1f389',
  '🌍': '1f30d',
  '❤️': '2764',
  '🚀': '1f680',
};

function emojiGlyph(glyph: DemoGlyph, style: ReturnType<typeof getBrowserEmojiStyle>['value']) {
  if (style === 'system') {
    return glyph;
  }
  const code = assetCodes[glyph];
  // Twemoji artwork: CC BY 4.0. OpenMoji artwork: CC BY-SA 4.0.
  const src =
    style === 'twemoji'
      ? `https://cdn.jsdelivr.net/gh/jdecked/twemoji@v16.0.1/assets/svg/${code}.svg`
      : `https://cdn.jsdelivr.net/npm/openmoji@16.0.0/color/svg/${code.toUpperCase()}.svg`;
  return (
    <img src={src} alt={glyph} style={{ width: '1em', height: '1em', verticalAlign: '-0.12em' }} />
  );
}

export const GET = defineHandler((c) => {
  const renderer = selectRenderer(c.req.query('renderer'));
  const requested = c.req.query('emoji');
  const emoji = takumiEmojiStyles.find((style) => style === requested) ?? 'twemoji';
  const { label, value: browserStyle } = getBrowserEmojiStyle(c.req.query('style'));
  const sample = renderer
    ? c.req.query('sample') === 'joined'
      ? '👩‍💻 🎉 🌍 ❤️'
      : '😀 🎉 🌍 ❤️'
    : sampleGlyphs.map((glyph, index) => (
        <span key={glyph}>
          {index > 0 ? ' ' : ''}
          {emojiGlyph(glyph, browserStyle)}
        </span>
      ));
  return previewImage(
    <Card>
      <div style={{ fontSize: 30, color: '#38bdf8' }}>{renderer ? `EMOJI / ${emoji}` : label}</div>
      <div style={{ fontSize: 68, fontWeight: 700 }}>
        {'Ship something great '}
        {renderer ? '🚀' : emojiGlyph('🚀', browserStyle)}
      </div>
      <div style={{ fontSize: 108 }}>{sample}</div>
    </Card>,
    {
      width: 1200,
      height: 630,
      ...(renderer
        ? { renderer: [renderer, { emoji, images: { timeout: 5000 } }] }
        : { font: 'Roboto' }),
    },
  );
});
