# Vue Pages Playground

Vue full-stack app demonstrating Void's Inertia-inspired Pages mode with SSR, companion `.server.ts` files, form handling, and layout nesting.

## Structure

```
pages/
  layout.vue                # Root layout with nav bar and useShared()
  index.vue                 # Home page
  index.server.ts           # Server handler for home page
  users/
    index.vue               # Users list + add-user form
    index.server.ts         # Server handler with loader + action
    [id].vue                # Dynamic user detail page
    [id].server.ts          # Server handler for [id] page
routes/api/
  health.ts                 # Health check endpoint (GET /api/health)
middleware/
  01.shared.ts              # Sets shared context data (appName)
db/
  schema.ts                 # Drizzle schema
  migrations/               # Users table schema
```

## Features

- **File-based page routing** — `.vue` files in `pages/` auto-create routes
- **Companion `.server.ts` files** — co-located server handlers for each page:
  - `loader()` returns props on GET (read-only data fetching)
  - `action()` handles mutations on POST/PUT (form submissions)
- **SSR + client hydration** — initial load returns SSR HTML; subsequent navigations return JSON via Pages protocol (`X-VoidPages` header)
- **Layout nesting** — `layout.vue` wraps child pages with shared nav using `<slot />`
- **`useForm` composable** — form state management with `hasChanges`, `pending`, `wasSuccessful`, `recentlySuccessful`, `errors`, `form.post()` / `form.put()`
- **`useShared` composable** — accesses middleware-set shared data (e.g. `appName` set in `01.shared.ts`)
- **`Link` component** — SPA navigation (renders `<a>` for GET, `<button>` for non-GET methods)
- **`ValidationError`** — throw from `action()` to surface field-level validation errors to the form
- **API route coexistence** — regular `routes/api/` routes work alongside pages
