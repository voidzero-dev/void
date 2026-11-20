import type { RenderImageOptions } from 'void/image';

export interface ImageQuery extends Pick<RenderImageOptions, 'width' | 'height'> {
  text: string;
  iterations: number;
}

function integer(
  query: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = query.get(name);
  if (value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function parseImageQuery(query: URLSearchParams): ImageQuery {
  const text = query.get('text') ?? 'TEST_TEXT';
  if (text.length > 4096) {
    throw new TypeError('text must be at most 4096 UTF-16 code units.');
  }
  return {
    text,
    width: integer(query, 'width', 1200, 1, 4096),
    height: integer(query, 'height', 630, 1, 4096),
    iterations: integer(query, 'iterations', 1, 0, 100),
  };
}
