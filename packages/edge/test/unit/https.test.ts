import { describe, expect, it } from 'vite-plus/test';
import { redirectToHttps } from '../../src/index.ts';

describe('redirectToHttps', () => {
  it('does not treat a public hostname starting with 127 as loopback', () => {
    expect(redirectToHttps(new Request('http://127.example.com/'))?.headers.get('Location')).toBe(
      'https://127.example.com/',
    );
  });
  it.each(['GET', 'HEAD', 'POST'])('preserves the URL and unconsumed %s body', (method) => {
    const request = new Request('http://oxc.rs:8080/docs/a%2Fb?search=a%2Fb&tag=1&tag=2', {
      method,
      ...(method === 'POST' ? { body: 'payload' } : {}),
    });
    const response = redirectToHttps(request)!;
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe(
      'https://oxc.rs/docs/a%2Fb?search=a%2Fb&tag=1&tag=2',
    );
    expect(request.bodyUsed).toBe(false);
  });

  it.each([
    'https://oxc.rs/',
    'http://localhost:8787/',
    'http://app.localhost:8787/',
    'http://127.0.0.1:8787/',
    'http://127.0.0.2:8787/',
    'http://[::1]:8787/',
    'http://oxc.rs/.well-known/acme-challenge/token',
    'http://oxc.rs/.well-known/pki-validation/token.txt',
  ])('does not redirect %s', (url) => {
    expect(redirectToHttps(new Request(url))).toBeUndefined();
  });
});
