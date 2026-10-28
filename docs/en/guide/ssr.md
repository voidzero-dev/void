---
outline: deep
---

# Custom SSR

Use custom SSR to choose your own router, data loading, HTML shell, and hydration code. If you want Void to handle these for you, use [Pages Routing](./pages-routing/overview).

## Create the app

Start with a root component. This React example renders a page based on the request path:

```tsx
// src/App.tsx
export default function App({ url }: { url: string }) {
  return url === '/about' ? <main>About</main> : <main>Home</main>;
}
```

## Required entries

Create both entry files:

- `src/main.ssr.ts` or `src/main.ssr.tsx`
- `src/main.client.ts` or `src/main.client.tsx`

Use one server entry and one client entry. Both are required.

## Render API

Wrap your server renderer with `defineRender()` and return an HTML response. Insert `assetTags.css` and `assetTags.preloads` in `<head>`, and `assetTags.body` before `</body>`:

```tsx
// src/main.ssr.tsx
import { renderToString } from 'react-dom/server';
import { defineRender } from 'void';
import App from './App';

export default defineRender(async (c, assetTags) => {
  const url = new URL(c.req.raw.url);
  const html = renderToString(<App url={url.pathname} />);
  return new Response(
    `<!doctype html>
<html>
  <head>${assetTags.css}${assetTags.preloads}</head>
  <body>
    <div id="root">${html}</div>
    ${assetTags.body}
  </body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
});
```

You can also export a named `render(c, assetTags)` function with the same signature. See [`defineRender`](../reference/api/handlers.md#definerender-handler) for the types.

## Hydrate in the browser

In the client entry, hydrate the same component:

```tsx
// src/main.client.tsx
import { hydrateRoot } from 'react-dom/client';
import App from './App';

hydrateRoot(document.getElementById('root')!, <App url={window.location.pathname} />);
```

## Caching

See [Revalidation](./edge/revalidation.md) for stale-while-revalidate caching of SSR pages.

API routes and static files are served before custom rendering. Unmatched non-API requests use `render(c, assetTags)`.
