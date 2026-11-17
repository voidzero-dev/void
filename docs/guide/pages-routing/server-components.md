# Server Components

Server components are Void Pages that render to HTML without a framework adapter or browser hydration. Choose **None** when creating a Void project to start with one, or use `--framework none`.

Create `pages/index.server.tsx` to serve `/`:

```tsx
export default function Page() {
  return <h1>Hello, world!</h1>;
}
```

Use `pages/about.server.tsx` or `pages/about/index.server.tsx` for `/about`. Void renders the default export. A `.server.*` file that only exports a loader or actions is still a companion to an adapter page.

Void compiles server views and their imported JSX components with [Hono JSX](https://hono.dev/docs/guides/jsx). For TypeScript editor support, set these options in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "void/jsx"
  }
}
```

In a mixed project, keep the adapter's TypeScript settings and use `/** @jsxImportSource void/jsx */` in files written for server JSX.

## Props, async work, and styles

Without a `loader`, the page's default export receives the request context (`CloudContext`). You can read query and route parameters directly, or omit the argument if you don't need the request:

```tsx
import type { CloudContext } from 'void';

export default function Page(c: CloudContext) {
  return <h1>Hello, {c.req.query('name') ?? 'world'}!</h1>;
}
```

If you export a `loader`, the page receives the loader's props instead of the request context, even if the loader returns `{}`:

```tsx
// pages/greeting.server.tsx
import { defineHandler, defineHead, type InferProps } from 'void';

export const loader = defineHandler((c) => ({
  name: c.req.query('name') ?? 'world',
}));

type Props = InferProps<typeof loader>;

export const head = defineHead<Props>((_c, { name }) => ({ title: `Hello, ${name}!` }));

export default function Page({ name }: Props) {
  return <h1>Hello, {name}!</h1>;
}
```

Void waits for any `defer()` values before calling `head` or rendering the page, including after a form action. Use `InferServerProps<typeof loader>` to infer the resolved types for a loader that uses `defer()`. There are no loading placeholders or browser-side updates. Without a loader, `head(c, props)` still receives the context first and an empty props object second.

Imported components receive the props you pass in JSX. For example, put this component outside `pages/`, import it in your page, and render `<Button label="Save" />`:

```tsx
import styles from './Button.module.css';

export function Button({ label }: { label?: string }) {
  return <button class={styles.button}>{label ?? 'Press me!'}</button>;
}
```

Pages, layouts, and imported components can be async. Void runs their bodies when rendering and awaits their results before sending the document. CSS and CSS modules imported by a page or its components are included in the document without shipping the component code to the browser.

Import server JSX types and helpers such as `FC`, `memo`, `ErrorBoundary`, `createContext`, and `useContext` from `void/jsx`. Calling hooks or reactive primitives from React, Solid, or another client renderer is not supported. Use a hydrated adapter page when you need client state, event handlers, or effects.

Read Hono context before the first `await` in an async component for portability. On Cloudflare Workers, reading it after an `await` requires the `nodejs_compat` compatibility flag.

## Layouts and not-found views

Default-export a component in `pages/layout.server.tsx` to wrap server pages. A layout receives the request context and the child JSX as its second argument:

```tsx
import type { CloudContext } from 'void';
import type { Child } from 'void/jsx';
import './site.css';

export default function Layout(_c: CloudContext, children: Child) {
  return <main>{children}</main>;
}
```

On a server page, export `const layout = 'landing'` to replace the innermost layout with the nearest `_layouts/landing.server.tsx`. Use `'!landing'` to replace the entire chain, or `false` to render without a layout. You cannot set `ssr = false` on a server component.

Default-export a component in `pages/_not-found.server.tsx` to render a custom 404. A server page whose loader returns a 404 uses the nearest matching server not-found view and retains the applicable layouts.

Server and adapter pages may live in the same project, but they use separate layout trees. Use regular links to navigate to server pages; they render a new document instead of updating a hydrated page.

## Prerendering

Server pages use the same [prerendering options](../edge/prerendering.md) as other Pages. Export `prerender = true` to opt in, or `prerender = false` to opt out of [static output](../ssg.md) for a page. For a dynamic route, export `getPrerenderPaths()` to enumerate the URLs to generate. Prerendering includes the title and metadata returned by `head`. Leave pages that depend on a visitor's session on request-time rendering.

See the [Server Components playground](https://github.com/voidzero-dev/void/tree/main/playground/server-components) for runnable examples.
