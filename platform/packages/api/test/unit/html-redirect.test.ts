import { describe, it, expect } from 'vite-plus/test';
import { localhostRedirectResponse } from '../../src/html-redirect.ts';

describe('localhostRedirectResponse', () => {
  it('does not let a malicious target break out of the inline <script>', async () => {
    const target = 'http://localhost:9999/cb?x=</script><script>evil()</script>';
    const body = await localhostRedirectResponse(target).text();

    // Only the helper's own <script>/</script> tags survive — the target's
    // injected </script><script> did NOT break out as raw tags.
    expect((body.match(/<script>/g) || []).length).toBe(1);
    expect((body.match(/<\/script>/g) || []).length).toBe(1);
    // The target's `<` was escaped in the JS string literal.
    expect(body).toContain(String.raw`\u003c`);
  });

  it('HTML-escapes the noscript meta-refresh attribute', async () => {
    const target = 'http://localhost:9999/cb?q="><img>';
    const body = await localhostRedirectResponse(target).text();

    const match = /content="0;url=([^"]*)"/.exec(body);
    expect(match).not.toBeNull();
    const attr = match![1]!;
    // Escaped forms present, raw breakout chars absent inside the attribute.
    expect(attr).toContain('&quot;');
    expect(attr).toContain('&lt;');
    expect(attr).not.toContain('"');
    expect(attr).not.toContain('<');
  });

  it('embeds a plain (no-&) URL target unchanged', async () => {
    const target = 'http://localhost:9999/callback?link_code=AAA.BBB';
    const body = await localhostRedirectResponse(target).text();

    expect(body).toContain('location.replace("http://localhost:9999/callback?link_code=AAA.BBB")');
  });
});
