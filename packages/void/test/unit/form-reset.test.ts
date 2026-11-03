import { describe, expect, it } from 'vite-plus/test';
import {
  cloneFormValue,
  isFormResetOptions,
  parseFormResetArgs,
} from '../../src/pages/form-reset.ts';

describe('cloneFormValue', () => {
  it('copies nested records and arrays independently', () => {
    const source = { profile: { name: '' }, tags: [{ name: 'react' }] };
    const copy = cloneFormValue(source);
    copy.profile.name = 'Alice';
    copy.tags[0].name = 'vue';
    copy.tags.push({ name: 'solid' });
    expect(source).toEqual({ profile: { name: '' }, tags: [{ name: 'react' }] });
  });

  it('preserves opaque form values such as file uploads', () => {
    const source = {
      file: new File(['hello'], 'hello.txt'),
      blob: new Blob(['hello']),
      date: new Date(),
    };
    const copy = cloneFormValue(source);
    expect(copy.file).toBe(source.file);
    expect(copy.blob).toBe(source.blob);
    expect(copy.date).toBe(source.date);
  });

  it('preserves shared records and null prototypes without invoking prototype setters', () => {
    const record = Object.assign(Object.create(null), { name: 'Alice' }) as Record<string, unknown>;
    const source = {
      first: record,
      second: record,
      ...JSON.parse('{"__proto__":{"name":"safe"}}'),
    };
    const copy = cloneFormValue(source);
    expect(copy.first).toBe(copy.second);
    expect(copy.first).not.toBe(record);
    expect(Object.getPrototypeOf(copy.first)).toBeNull();
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, '__proto__')).toBe(true);
  });
});

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

  it('accepts empty options with or without field names', () => {
    expect(parseFormResetArgs([{}])).toEqual({ initial: false, fields: [] });
    expect(parseFormResetArgs([{}, 'title'])).toEqual({ initial: false, fields: ['title'] });
  });
});

describe('isFormResetOptions', () => {
  it('detects reset option objects', () => {
    expect(isFormResetOptions({ initial: true })).toBe(true);
    expect(isFormResetOptions({})).toBe(true);
    expect(isFormResetOptions('title')).toBe(false);
    expect(isFormResetOptions(null)).toBe(false);
  });
});
