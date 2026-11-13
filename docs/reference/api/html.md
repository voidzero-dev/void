---
description: 'Create HTML templates that escape dynamic text for route responses and generated images.'
outline: deep
---

# HTML Templates

`void/html` modules provides a set of helpers to safely render HTML strings.

## `html` template literal {#html}

Use `html` to write markup with dynamic text. Interpolated strings are escaped automatically, including `&`, `<`, `>`, and quotes:

```ts
import { defineHandler } from 'void';
import { html } from 'void/html';

export const GET = defineHandler(async (c) => {
  const name = c.req.query('name') ?? 'World';
  return c.html(await html`<h1>Hello ${name}</h1>`);
});
```

For `?name=<b>World</b>`, the response displays `Hello <b>World</b>` as text rather than making it bold. Return templates through `c.html()` for an HTML response.

### Nested and asynchronous templates

Nest templates to compose markup. Nested templates keep their markup, while dynamic text inside them is escaped. Interpolated promises are resolved before rendering:

```ts
import { html } from 'void/html';

const heading = html`<h1>${Promise.resolve('Hello <World>')}</h1>`;
const page = await html`<main>${heading}</main>`;
```

`html` returns `HtmlEscapedString | Promise<HtmlEscapedString>`. Use `await` when passing a template to `c.html()` so both synchronous and asynchronous content work.

### Image responses

[`ImageResponse`](../../guide/image-generation.md) and [`OgImageResponse`](../../guide/og-images.md) accept templates directly, including asynchronous templates, without an extra `await`. Plain strings are not accepted:

```ts
import { defineHandler } from 'void';
import { html } from 'void/html';
import { OgImageResponse } from 'void/og';

export const GET = defineHandler((c) => {
  const title = c.req.query('title') ?? 'Hello World';
  return new OgImageResponse(html`<div style="display: flex; font-size: 72px">${title}</div>`);
});
```

## `raw(value)` {#raw}

Use `raw` to insert raw string bypassing the sanitizer:

```ts
import { html, raw } from 'void/html';

const showGreeting = true;
const page = await html`<main>${raw(showGreeting ? '<strong>Hello</strong>' : '')}</main>`;
```

::: danger
Never pass untrusted request input or user-generated content to it. Interpolate that text directly into `html` instead.
:::

## `HtmlEscapedString`

Use this type for reusable template results. For helpers that can return asynchronous content, include `Promise<HtmlEscapedString>`:

```ts
import { html, type HtmlEscapedString } from 'void/html';

function heading(title: string): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<h1>${title}</h1>`;
}
```
