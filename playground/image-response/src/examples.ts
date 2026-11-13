import { fontPresets } from './fonts.ts';

export interface Control {
  name: string;
  label: string;
  value: string;
  options?: Array<{ value: string; label: string }>;
}

interface Example {
  id: string;
  title: string;
  description: string;
  file: string;
  code: string;
  checks: Array<string>;
  controls: Array<Control>;
  network?: string;
}

export const examples: Array<Example> = [
  {
    id: 'article',
    title: 'JSX article card',
    description: 'A reusable JSX component, route data, and an absolute og:image in the page head.',
    file: 'routes/og/article/[slug].tsx',
    code: 'return new ImageResponse(<Card>…{post.title}…</Card>);',
    checks: [
      'The PNG is 1200 × 630 with Inter text and a byline.',
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
    title: 'Tailwind and debug borders',
    description: 'Utility classes, a gradient, and a two-column layout without a CSS build step.',
    file: 'routes/og/layout.tsx',
    code: 'new ImageResponse(<div tw="flex h-full w-full …">…</div>, { debug });',
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
    title: 'Bundled and custom variable fonts',
    description:
      'Compare bundled Inter and Geist with four custom variable typefaces, with multiple weights in each image.',
    file: 'routes/og/fonts.tsx',
    code: "new ImageResponse(card, { width: 1200, height: 630, defaultFont: 'Geist', fallbackFonts: false });",
    network:
      'Inter and Geist need no download in either mode. Custom fonts download from fonts.gstatic.com.',
    checks: [
      'The 400, 550, and 700 rows get progressively heavier without boxes or clipping.',
      'Switch typefaces to compare clean sans-serif, slab serif, editorial serif, monospace, and handwriting styles.',
      'URL and font-data modes should look the same. No weight is pinned on the variable font entry.',
      'Inter and Geist work offline; switching between them must not carry over the previous font.',
    ],
    controls: [
      {
        name: 'font',
        label: 'Typeface',
        value: 'inter',
        options: fontPresets.map((font) => ({ value: font.id, label: font.label })),
      },
      {
        name: 'mode',
        label: 'Font source',
        value: 'url',
        options: [
          { value: 'url', label: 'Font URL' },
          { value: 'data', label: 'Font bytes' },
        ],
      },
    ],
  },
  {
    id: 'languages',
    title: 'Multilingual fallback fonts',
    description: 'Mixed scripts, accented Latin, symbols, and language-specific Chinese glyphs.',
    file: 'routes/og/languages.tsx',
    code: "new ImageResponse(card, { lang: 'zh-TW', fallbackFonts: true });",
    network:
      'Automatic fallback downloads fonts from Google Fonts. The first render can be slower.',
    checks: [
      'With fallback enabled, Japanese, Łódź, Arabic, Thai, and symbols should not be boxes.',
      'Switch the language to compare the same Han characters in Japanese, Simplified Chinese, Traditional Chinese, and Korean styles.',
      'Disable fallback to see missing glyphs while Latin, Cyrillic, and Greek remain readable in Inter; switch it back on to compare.',
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
  },
  {
    id: 'emoji',
    title: 'Emoji styles',
    description: 'Compare the six emoji sets, with a separate sample for joined emoji.',
    file: 'routes/og/emoji.tsx',
    code: "new ImageResponse(card, { emoji: 'twemoji' });",
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
        options: ['twemoji', 'blobmoji', 'noto', 'openmoji', 'fluent', 'fluentFlat'].map(
          (value) => ({ value, label: value }),
        ),
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
  },
  {
    id: 'remote',
    title: 'Remote image policies',
    description:
      'A fixed remote avatar with allow-listing, size limits, and strict or lenient failures.',
    file: 'routes/og/remote.tsx',
    code: 'new ImageResponse(card, { images: { allowUrl, maxBytes, timeout: 5000, throwOnError } });',
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

export function imagePath(id: string, values: Record<string, string>) {
  if (id === 'article') {
    return `/og/article/${encodeURIComponent(values.slug ?? 'hello')}`;
  }
  const query = new URLSearchParams(values).toString();
  return `/og/${id}${query ? `?${query}` : ''}`;
}
