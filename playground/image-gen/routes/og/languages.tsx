/** @jsxImportSource void/jsx */
import { defineHandler } from 'void';
import { Card } from '../../src/card.tsx';
import { getBrowserLanguageFont } from '../../src/language-fonts.ts';
import { previewImage, selectRenderer } from '../../src/renderer.server.ts';

export const GET = defineHandler((c) => {
  const renderer = selectRenderer(c.req.query('renderer'));
  const requested = c.req.query('lang') ?? 'ja';
  const lang = ['ja', 'zh-CN', 'zh-TW', 'ko'].includes(requested) ? requested : 'ja';
  const fallbackFonts = c.req.query('fallback') !== 'off';
  const { families } = getBrowserLanguageFont(c.req.query('font'));
  return previewImage(
    <Card>
      <div style={{ fontSize: renderer ? 26 : 20, color: '#38bdf8' }}>
        {renderer
          ? `${fallbackFonts ? 'ROBOTO + FALLBACK FONTS' : 'ROBOTO ONLY'} / ${lang}`
          : families.join(' → ')}
      </div>
      <div style={{ fontSize: 54, fontWeight: 700 }}>Hello, Łódź! → ★</div>
      <div style={{ fontSize: 36 }}>Тёплый чай · Свіжі булочки / Ελληνικά</div>
      <div style={{ fontSize: 60 }}>骨 直 令 / 世界 / タワー</div>
      <div style={{ fontSize: 44 }}>مرحبا بالعالم</div>
      <div style={{ fontSize: 44 }}>สวัสดีชาวโลก</div>
    </Card>,
    {
      width: 1200,
      height: 630,
      ...(renderer ? { renderer: [renderer, { fallbackFonts }], lang } : { font: families }),
    },
  );
});
