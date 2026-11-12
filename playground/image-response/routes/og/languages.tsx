import { defineHandler } from 'void';
import { ImageResponse } from 'void/og';
import { Card } from '../../src/card.tsx';

export const GET = defineHandler((c) => {
  const requested = c.req.query('lang') ?? 'ja';
  const lang = ['ja', 'zh-CN', 'zh-TW', 'ko'].includes(requested) ? requested : 'ja';
  return new ImageResponse(
    <Card>
      <div style={{ fontSize: 26, color: '#38bdf8' }}>GEIST + FALLBACK FONTS / {lang}</div>
      <div style={{ fontSize: 54, fontWeight: 700 }}>Hello, Łódź! → ★</div>
      <div style={{ fontSize: 60 }}>骨 直 令 / 世界 / タワー</div>
      <div style={{ fontSize: 44 }}>مرحبا بالعالم</div>
      <div style={{ fontSize: 44 }}>สวัสดีชาวโลก</div>
    </Card>,
    { lang, fallbackFonts: c.req.query('fallback') !== 'off' },
  );
});
