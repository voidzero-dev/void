import { describe, expect, it } from 'vite-plus/test';
import { compileEmailPattern } from '../../src/shared/email-pattern.ts';

describe('compileEmailPattern', () => {
  it('compiles static address', () => {
    expect(compileEmailPattern('support')).toEqual({
      kind: 'static',
      regexSource: '^support$',
      paramNames: [],
    });
  });

  it('compiles static + tag', () => {
    expect(compileEmailPattern('support+[ticket]')).toEqual({
      kind: 'static-tag',
      regexSource: String.raw`^support\+([^+@]+)$`,
      paramNames: ['ticket'],
    });
  });

  it('compiles dynamic', () => {
    expect(compileEmailPattern('[user]')).toEqual({
      kind: 'dynamic',
      regexSource: '^([^+@]+)$',
      paramNames: ['user'],
    });
  });

  it('compiles dynamic + tag', () => {
    expect(compileEmailPattern('[user]+[tag]')).toEqual({
      kind: 'dynamic-tag',
      regexSource: String.raw`^([^+@]+)\+([^+@]+)$`,
      paramNames: ['user', 'tag'],
    });
  });

  it('escapes literal dots', () => {
    expect(compileEmailPattern('alerts.ops')).toEqual({
      kind: 'static',
      regexSource: String.raw`^alerts\.ops$`,
      paramNames: [],
    });
  });

  it('returns null for too many `+` separators', () => {
    expect(compileEmailPattern('a+b+c')).toBeNull();
  });

  it('returns null for invalid literal chars', () => {
    expect(compileEmailPattern('hello world')).toBeNull();
  });

  it('lowercases uppercase basenames before compilation', () => {
    // Patterns are lowercased to match the lowercased recipient — uppercase
    // in the filename is fine, just normalized.
    expect(compileEmailPattern('[Foo]')?.paramNames).toEqual(['foo']);
    expect(compileEmailPattern('Support')?.regexSource).toBe('^support$');
  });

  it('returns null for invalid param shapes', () => {
    expect(compileEmailPattern('[1abc]')).toBeNull(); // starts with digit
    expect(compileEmailPattern('[]')).toBeNull(); // empty
  });
});
