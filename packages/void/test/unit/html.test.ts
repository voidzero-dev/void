import { Hono } from 'hono';
import { html as honoHtml, raw as honoRaw } from 'hono/html';
import { describe, expect, it } from 'vite-plus/test';
import { html, raw } from '../../src/runtime/html.ts';

describe('void/html', () => {
  it('re-exports the Hono template tag and raw helper', () => {
    expect(html).toBe(honoHtml);
    expect(raw).toBe(honoRaw);
  });

  it('escapes interpolated text', async () => {
    const title = '<img src="https://example.com/injected.png"> & \'quoted\'';
    const result = await html`<h1>${title}</h1>`;
    expect(result.toString()).toBe(
      '<h1>&lt;img src=&quot;https://example.com/injected.png&quot;&gt; &amp; &#39;quoted&#39;</h1>',
    );
    expect(result.isEscaped).toBe(true);
  });

  it('composes nested templates and asynchronous text', async () => {
    const content = html`<strong>${Promise.resolve('<Hello>')}</strong>`;
    const result = await html`<main>${content}</main>`;
    expect(result.toString()).toBe('<main><strong>&lt;Hello&gt;</strong></main>');
    expect(result.isEscaped).toBe(true);
  });

  it('preserves explicitly trusted raw markup while escaping other text', async () => {
    const trusted = raw('<strong>Hello</strong>');
    expect(trusted.isEscaped).toBe(true);
    expect(trusted.toString()).toBe('<strong>Hello</strong>');
    const result = await html`<main>${trusted}${'<World>'}</main>`;
    expect(result.toString()).toBe('<main><strong>Hello</strong>&lt;World&gt;</main>');
  });

  it('returns HTML through the handler context', async () => {
    const app = new Hono();
    app.get('/', async (c) => c.html(await html`<h1>${Promise.resolve('<Hello>')}</h1>`));
    const response = await app.request('/');
    expect(response.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    expect(await response.text()).toBe('<h1>&lt;Hello&gt;</h1>');
  });
});
