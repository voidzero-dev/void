import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { logger } from '../../src/runtime/log.ts';

describe('runtime log', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logger.error calls console.error with stringified JSON', () => {
    logger.error('boom', { jobId: 'j1' });

    expect(console.error).toHaveBeenCalledTimes(1);
    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof arg).toBe('string');
    expect(JSON.parse(arg as string)).toEqual({ msg: 'boom', jobId: 'j1' });
  });

  it('logger.warn calls console.warn with stringified JSON', () => {
    logger.warn('careful', { reason: 'slow' });

    expect(console.warn).toHaveBeenCalledTimes(1);
    const arg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(arg as string)).toEqual({ msg: 'careful', reason: 'slow' });
  });

  it('logger.info calls console.info with stringified JSON', () => {
    logger.info('hello', { user: 'alice' });

    expect(console.info).toHaveBeenCalledTimes(1);
    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(arg as string)).toEqual({ msg: 'hello', user: 'alice' });
  });

  it('JSON has msg as the first key, followed by fields', () => {
    logger.info('m', { a: 1, b: 2 });

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(Object.keys(parsed)).toEqual(['msg', 'a', 'b']);
  });

  it('fields is optional — calling without fields works', () => {
    logger.error('lonely');

    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(JSON.parse(arg)).toEqual({ msg: 'lonely' });
  });

  it('msg argument wins when fields contain a msg key', () => {
    logger.error('intended', { msg: 'sneaky', extra: 1 });

    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(JSON.parse(arg)).toEqual({ msg: 'intended', extra: 1 });
  });

  it('a `toJSON` key in fields cannot hijack the output shape', () => {
    logger.info('visible', {
      toJSON: () => ({ level: 'error' }),
      x: 1,
    } as Record<string, unknown>);

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('visible');
    expect(parsed.x).toBe(1);
    expect('toJSON' in parsed).toBe(false);
    expect('level' in parsed).toBe(false);
  });

  it('inherited enumerable keys from the prototype chain are not copied', () => {
    const parent = { inherited: 'should-not-appear' };
    const fields = Object.create(parent) as Record<string, unknown>;
    fields.own = 'should-appear';

    logger.info('proto', fields);

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('proto');
    expect(parsed.own).toBe('should-appear');
    expect('inherited' in parsed).toBe(false);
  });

  it('an own enumerable `__proto__` cannot hijack the output via prototype mutation', () => {
    const fields = {} as Record<string, unknown>;
    Object.defineProperty(fields, '__proto__', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { toJSON: () => ({ msg: 'hacked', level: 'error' }) },
    });

    logger.info('visible', fields);

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('visible');
    expect('level' in parsed).toBe(false);
  });

  it('throwing enumerable getters do not crash — fallback to safe shape', () => {
    const fields = { ok: 1 } as Record<string, unknown>;
    Object.defineProperty(fields, 'bomb', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('boom');
      },
    });

    expect(() => logger.error('getter', fields)).not.toThrow();

    expect(console.error).toHaveBeenCalledTimes(1);
    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('getter');
    expect(parsed.error).toBe('log: fields not serializable');
  });

  it('a `constructor` key in fields is skipped', () => {
    logger.info('ctor', { constructor: 'evil', keep: 'yes' });

    const arg = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe('ctor');
    expect(parsed.keep).toBe('yes');
    // Object.prototype already has `constructor`, so check own properties only.
    expect(Object.hasOwn(parsed, 'constructor')).toBe(false);
  });

  it('non-stringifiable values (circular refs) do not crash — fallback to safe shape', () => {
    const circular: Record<string, unknown> = { name: 'cycle' };
    circular.self = circular;

    expect(() => logger.error('circular failure', circular)).not.toThrow();

    expect(console.error).toHaveBeenCalledTimes(1);
    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof arg).toBe('string');
    const parsed = JSON.parse(arg as string);
    expect(parsed.msg).toBe('circular failure');
  });

  it('Error fields keep name, message, stack and cause', () => {
    const inner = new Error('inner');
    const error = new Error('wrapped', { cause: inner });

    logger.error('save failed', { error });

    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.error).toEqual({
      name: 'Error',
      message: 'wrapped',
      stack: error.stack,
      cause: { name: 'Error', message: 'inner', stack: inner.stack },
    });
  });

  it('Error subclasses keep their own enumerable fields', () => {
    class AppError extends Error {
      status = 500;
    }

    logger.error('save failed', { error: new AppError('boom') });

    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.error).toMatchObject({ status: 500, name: 'Error', message: 'boom' });
    expect(typeof parsed.error.stack).toBe('string');
  });

  it('a cyclic Error cause does not drop the other fields', () => {
    const error = new Error('loop');
    error.cause = error;

    logger.error('cycle', { error, jobId: 'j1' });

    const arg = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.jobId).toBe('j1');
    expect(parsed.error.message).toBe('loop');
    expect(parsed.error.cause).toEqual({ name: 'Error', message: 'loop' });
  });
});
