import { describe, expect, it } from 'vite-plus/test';
import { convertReturnValue } from '../../src/runtime/handler/response.ts';

describe('convertReturnValue', () => {
  it('passes through Response objects', () => {
    const res = new Response('ok', { status: 200 });
    expect(convertReturnValue(res)).toBe(res);
  });

  it('null → 204 No Content', () => {
    const res = convertReturnValue(null);
    expect(res.status).toBe(204);
  });

  it('undefined → 204 No Content', () => {
    const res = convertReturnValue(undefined);
    expect(res.status).toBe(204);
  });

  it('string → text/html', async () => {
    const res = convertReturnValue('hello world');
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('hello world');
  });

  it('object → JSON', async () => {
    const res = convertReturnValue({ hello: 'world' });
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  it('array → JSON', async () => {
    const res = convertReturnValue([1, 2, 3]);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual([1, 2, 3]);
  });

  it('number → JSON', async () => {
    const res = convertReturnValue(42);
    expect(await res.json()).toBe(42);
  });

  it('boolean → JSON', async () => {
    const res = convertReturnValue(true);
    expect(await res.json()).toBe(true);
  });
});
