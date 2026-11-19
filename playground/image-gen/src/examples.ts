import { browserEmojiStyles, takumiEmojiStyles } from './emoji-styles.ts';
import { defaultFontId, fontGroups } from './fonts.ts';
import { browserLanguageFonts, getBrowserLanguageFont } from './language-fonts.ts';
import type { RendererChoice } from './renderer-select.tsx';

export interface Control {
  name: string;
  label: string;
  value: string;
  options?: Array<{ value: string; label: string; group?: string }>;
}

interface ExamplePreview {
  code: string;
  checks: Array<string>;
  controls: Array<Control>;
  network?: string;
}

interface Example extends ExamplePreview {
  id: string;
  title: string;
  description: string;
  file: string;
  browser?: ExamplePreview;
  takumiOnly?: boolean;
}

export const examples: Array<Example> = [
  {
    id: 'article',
    title: 'JSX article card',
    description: 'A reusable JSX component, route data, and an absolute og:image in the page head.',
    file: 'routes/og/article/[slug].tsx',
    code: 'return new ImageResponse(<Card>…{post.title}…</Card>);',
    checks: [
      'The PNG is 1200 × 630 with Roboto text and a byline.',
      'Choose the long title to check wrapping. Open the missing article URL to check its 404.',
      'View page source for og:image and twitter:card; the image URL includes the selected slug.',
    ],
    controls: [
      {
        name: 'slug',
        label: 'Article',
        value: 'hello',
        options: [
          { value: 'hello', label: 'Short title' },
          { value: 'long', label: 'Long title' },
        ],
      },
    ],
  },
  {
    id: 'html',
    title: 'HTML with request input',
    description: 'Framework-independent markup with an escaped title from the query string.',
    file: 'routes/og/html.ts',
    code: 'new ImageResponse(html`<div …>${title}</div>`);',
    checks: [
      'The title appears literally, including <b>, &, and quotes; it must not become markup.',
      'Edit the title, then leave the field or press Enter. A long title should wrap without leaving the card.',
    ],
    controls: [{ name: 'title', label: 'Title', value: 'Void <b>is not HTML</b> & "friends"' }],
  },
  {
    id: 'layout',
    title: 'Inline CSS and debug borders',
    description: 'A gradient and a two-column layout using inline CSS.',
    file: 'routes/og/layout.tsx',
    code: "new ImageResponse(<div style={{ display: 'flex' }}>…</div>, { debug });",
    checks: [
      'The card has two columns, rounded boxes, and a gradient background.',
      'Enable debug to see borders around the layout boxes; disable it to compare.',
    ],
    controls: [
      {
        name: 'debug',
        label: 'Debug borders',
        value: 'off',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ],
      },
    ],
  },
  {
    id: 'square',
    title: 'Square image and response headers',
    description: 'A 600 × 600 social card with an explicit cache policy and a custom header.',
    file: 'routes/og/square.tsx',
    code: "new ImageResponse(card, { width: 600, height: 600, headers: { 'Cache-Control': 'no-store', 'X-OG-Demo': 'square' } });",
    checks: [
      'The actual PNG dimensions are 600 × 600, not just a square browser crop.',
      'The response shows Content-Type image/png, Cache-Control no-store, and X-OG-Demo square.',
    ],
    controls: [],
  },
  {
    id: 'fonts',
    title: 'Browser Run fonts and Google Fonts',
    description:
      'Compare built-in Browser Run families with exact matches or substitutes from Google Fonts in either renderer.',
    file: 'routes/og/fonts.tsx',
    code: '<div style={{ fontFamily }}>Build with Void</div>',
    network:
      'Google Fonts options load WOFF2 files from fonts.gstatic.com. Browser Run can also use its pre-installed fonts without a download.',
    checks: [
      'Compare the same family across renderers. A Google Fonts substitute will not look identical to the original.',
      'Variable families can render intermediate weights; static families may reuse a nearby weight.',
      'Webdings has no Google Fonts substitute: Browser Run uses the built-in family and Takumi uses Roboto.',
    ],
    controls: [
      {
        name: 'font',
        label: 'Typeface',
        value: defaultFontId,
        options: fontGroups.flatMap(({ label: group, fonts }) =>
          fonts.map((font) => ({ value: font.id, label: font.family, group })),
        ),
      },
      {
        name: 'mode',
        label: 'Font source',
        value: 'auto',
        options: [
          { value: 'auto', label: 'Renderer default' },
          { value: 'url', label: 'Google Fonts URL' },
          { value: 'data', label: 'Google Fonts bytes' },
        ],
      },
    ],
  },
  {
    id: 'languages',
    title: 'Multilingual fallback fonts',
    description: 'Mixed scripts, accented Latin, symbols, and language-specific Chinese glyphs.',
    file: 'routes/og/languages.tsx',
    code: "new ImageResponse(card, { renderer: [takumiRenderer, { fallbackFonts: true }], lang: 'zh-TW' });",
    network:
      'Automatic fallback downloads fonts from Google Fonts. The first render can be slower.',
    checks: [
      'With fallback enabled, Japanese, Łódź, Arabic, Thai, and symbols should not be boxes.',
      'Switch the language to compare the same Han characters in Japanese, Simplified Chinese, Traditional Chinese, and Korean styles.',
      'Disable fallback to see missing glyphs while Latin, Cyrillic, and Greek remain readable in Roboto; switch it back on to compare.',
    ],
    controls: [
      {
        name: 'lang',
        label: 'Han glyph style',
        value: 'ja',
        options: [
          { value: 'ja', label: 'Japanese' },
          { value: 'zh-CN', label: 'Simplified Chinese' },
          { value: 'zh-TW', label: 'Traditional Chinese' },
          { value: 'ko', label: 'Korean' },
        ],
      },
      {
        name: 'fallback',
        label: 'Automatic fonts',
        value: 'on',
        options: [
          { value: 'on', label: 'Enabled' },
          { value: 'off', label: 'Disabled (expect missing glyphs)' },
        ],
      },
    ],
    browser: {
      code: "new ImageResponse(card, { font: ['Bitstream Vera Sans', 'Noto Sans CJK JP', 'KacstBook', 'Garuda'] });",
      checks: [
        'Roboto covers Latin, Cyrillic, and Greek. Chromium supplies system fonts for glyphs Roboto does not cover.',
        'Bitstream Vera Sans is the Latin face. “Latin Only” describes that face, not the whole image: Chromium still supplies missing glyphs.',
        'Try the explicit stacks. The Latin face stays the same while the fallback families can change the Han glyph style and the look of Arabic and Thai.',
      ],
      controls: [
        {
          name: 'font',
          label: 'Font stack',
          value: getBrowserLanguageFont(undefined).id,
          options: browserLanguageFonts.map(({ id, label, families }) => ({
            value: id,
            label: label ?? families.join(' → '),
          })),
        },
      ],
    },
  },
  {
    id: 'emoji',
    title: 'Emoji styles',
    description: 'Compare Takumi’s emoji sets with system emoji and SVG artwork in Browser Run.',
    file: 'routes/og/emoji.tsx',
    code: "new ImageResponse(card, { renderer: [takumiRenderer, { emoji: 'twemoji' }] });",
    network: 'Downloads emoji images from jsDelivr; repeat renders can reuse them.',
    checks: [
      'Switch styles: the emoji artwork changes, but the text and layout stay the same.',
      'Choose the joined sample: the technologist should be one emoji, not separate person and laptop images.',
      'An emoji missing from the chosen set fails the image. Compare another set and inspect the server log for the failed download URL.',
    ],
    controls: [
      {
        name: 'emoji',
        label: 'Emoji set',
        value: 'twemoji',
        options: takumiEmojiStyles.map((value) => ({ value, label: value })),
      },
      {
        name: 'sample',
        label: 'Sample',
        value: 'common',
        options: [
          { value: 'common', label: 'Common emoji' },
          { value: 'joined', label: 'Joined emoji (availability varies)' },
        ],
      },
    ],
    browser: {
      code: '<img src={emojiUrl} alt="🚀" />',
      network: 'The Twemoji and OpenMoji options load versioned SVG artwork from jsDelivr.',
      checks: [
        'System Emojis leaves the characters unchanged and lets Chromium render them.',
        'For Twemoji and OpenMoji, the example replaces the sample glyphs with SVG images in Hono JSX. Roboto still renders the text and spaces.',
        'The joined technologist emoji is rendered as a single image in both SVG sets.',
      ],
      controls: [
        {
          name: 'style',
          label: 'Emoji artwork',
          value: browserEmojiStyles[0].value,
          options: [...browserEmojiStyles],
        },
      ],
    },
  },
  {
    id: 'remote',
    title: 'Remote image policies',
    takumiOnly: true,
    description:
      'A fixed remote avatar with allow-listing, size limits, and strict or lenient failures.',
    file: 'routes/og/remote.tsx',
    code: 'new ImageResponse(card, { renderer: [takumiRenderer, { images: { allowUrl, maxBytes, timeout: 5000, throwOnError } }] });',
    network:
      'The allowed image downloads from avatars.githubusercontent.com. No arbitrary URL input.',
    checks: [
      'Allowed: the Vite avatar appears next to the text.',
      'Blocked / omit and size limit / omit: the card still renders without the avatar.',
      'Blocked / fail: the image intentionally fails. The response reports the failure; check the server log too.',
      'In dev, an intentional failure may open the Vite error overlay. Dismiss it to use the page again.',
    ],
    controls: [
      {
        name: 'mode',
        label: 'Image policy',
        value: 'allow',
        options: [
          { value: 'allow', label: 'Allowed' },
          { value: 'omit', label: 'Blocked / omit' },
          { value: 'limit', label: 'Size limit / omit' },
          { value: 'fail', label: 'Blocked / fail' },
        ],
      },
    ],
  },
];

export function getExample(id: string) {
  return examples.find((example) => example.id === id);
}

export function getExamplePreview(example: Example, renderer: RendererChoice): ExamplePreview {
  return renderer === 'browser' ? (example.browser ?? example) : example;
}

export function imagePath(id: string, values: Record<string, string>) {
  const params = new URLSearchParams(values);
  const path =
    id === 'article'
      ? `/og/article/${encodeURIComponent(params.get('slug') ?? 'hello')}`
      : `/og/${id}`;
  if (id === 'article') {
    params.delete('slug');
  }
  return `${path}${params.size ? `?${params}` : ''}`;
}
