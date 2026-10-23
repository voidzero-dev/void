import { describe, expect, it } from 'vite-plus/test';
import { isFormResetOptions, parseFormResetArgs } from '../../src/pages/form-reset.ts';

describe('parseFormResetArgs', () => {
  it('treats string arguments as field names', () => {
    expect(parseFormResetArgs(['title', 'body'])).toEqual({
      initial: false,
      fields: ['title', 'body'],
    });
  });

  it('reads initial from the first options object', () => {
    expect(parseFormResetArgs([{ initial: true }])).toEqual({ initial: true, fields: [] });
    expect(parseFormResetArgs([{ initial: true }, 'title'])).toEqual({
      initial: true,
      fields: ['title'],
    });
    expect(parseFormResetArgs([{ initial: false }, 'title'])).toEqual({
      initial: false,
      fields: ['title'],
    });
  });
});

describe('isFormResetOptions', () => {
  it('detects reset option objects', () => {
    expect(isFormResetOptions({ initial: true })).toBe(true);
    expect(isFormResetOptions('title')).toBe(false);
    expect(isFormResetOptions(null)).toBe(false);
  });
});
