import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { MockInstance } from 'vite-plus/test';
import {
  _resetUnmaskCacheForTests,
  isUnmaskActive,
  redactMessage,
  REDACTED,
} from '../../src/shared/env-mask.ts';

/** Validator messages redact raw inputs unconditionally unless explicitly unmasked. */

describe('redactMessage', () => {
  it('replaces the raw value in the message', () => {
    const msg = redactMessage('abc', 'Expected a number, got "abc"');
    expect(msg).toBe(`Expected a number, got "${REDACTED}"`);
  });

  it('is a no-op when unmask=true', () => {
    const msg = redactMessage('sk_live_abc', 'got "sk_live_abc"', { unmask: true });
    expect(msg).toBe('got "sk_live_abc"');
  });
});

describe('isUnmaskActive', () => {
  const origValue = process.env.VOID_ENV_UNMASK;
  let errSpy: MockInstance;

  beforeEach(() => {
    _resetUnmaskCacheForTests();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (origValue === undefined) {
      delete process.env.VOID_ENV_UNMASK;
    } else {
      process.env.VOID_ENV_UNMASK = origValue;
    }
    errSpy.mockRestore();
    _resetUnmaskCacheForTests();
  });

  it('returns false when env var is unset', () => {
    delete process.env.VOID_ENV_UNMASK;
    expect(isUnmaskActive()).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns true and prints a one-shot stderr notice when VOID_ENV_UNMASK=1', () => {
    process.env.VOID_ENV_UNMASK = '1';
    expect(isUnmaskActive()).toBe(true);
    // Called again: cached, no second notice.
    expect(isUnmaskActive()).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const printed = String(errSpy.mock.calls[0]?.[0] ?? '');
    expect(printed).toContain('VOID_ENV_UNMASK');
  });

  it('ignores non-"1" values', () => {
    process.env.VOID_ENV_UNMASK = 'true';
    expect(isUnmaskActive()).toBe(false);
  });
});
