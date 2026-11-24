import type { BrowserRunDefaultFontFamily } from 'void/image';

const latin = 'Bitstream Vera Sans';

export const browserLanguageFonts: Array<{
  id: string;
  families: Array<BrowserRunDefaultFontFamily>;
  label?: string;
}> = [
  { id: 'roboto', families: ['Roboto'], label: 'Roboto - Multilingual' },
  { id: 'latin', families: [latin], label: `${latin} - Latin Only` },
  {
    id: 'japanese',
    families: [latin, 'Noto Sans CJK JP', 'KacstBook', 'Garuda'],
  },
  {
    id: 'traditional-chinese',
    families: [latin, 'Noto Serif CJK TC', 'KacstOffice', 'Loma'],
  },
  {
    id: 'korean',
    families: [latin, 'Noto Sans CJK KR', 'KacstFarsi', 'Waree'],
  },
];

export function getBrowserLanguageFont(id: string | undefined) {
  return browserLanguageFonts.find((preset) => preset.id === id) ?? browserLanguageFonts[0];
}
