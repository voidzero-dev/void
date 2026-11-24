export const takumiEmojiStyles = [
  'twemoji',
  'blobmoji',
  'noto',
  'openmoji',
  'fluent',
  'fluentFlat',
] as const;

export const browserEmojiStyles = [
  { value: 'system', label: 'Roboto + System Emojis' },
  { value: 'twemoji', label: 'Roboto + Twemoji (SVG)' },
  { value: 'openmoji', label: 'Roboto + OpenMoji (SVG)' },
] as const;

export function getBrowserEmojiStyle(value: string | undefined) {
  return browserEmojiStyles.find((style) => style.value === value) ?? browserEmojiStyles[0];
}
