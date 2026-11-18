# Server auth errors

Compare auth checks, redirects, and page boundaries in a grid of React Pages examples.

From the repository root:

```sh
vp run --filter ./playground/server-auth-errors dev
```

Start signed out to see the limitations of a plain-text `401`. Compare document loads and client navigation: a native popover shows “Page loaded” for 2.5 seconds on document loads. Client visits do not show it again; plain-text responses replace the app entirely. The action examples offer native and enhanced forms, including inline errors and client error boundaries.

Submit `/login` to sign in as the demo user, then repeat the examples. The disabled fields show example credentials; the server ignores submitted fields and always uses the same demo account, creating it on first use. The app uses Void’s auth and local D1; dev creates the auth tables automatically. No Cloudflare login or OAuth provider is needed.

Source links open the corresponding files in VS Code. Use the Network panel with Preserve log to inspect statuses and redirects. The shared guard in `src/require-page-user.ts` throws a `302` for page visits or a `303` for actions.

The `requireAuth with throwRedirect` examples use the built-in option instead: `302` for GET/HEAD and `303` for other methods. All auth redirects go to `/login`; signing in opens the example grid.

## Tests

Run the Vitest browser integration from the repository root:

```sh
vp test run packages/void/test/integration/server-auth-errors.test.ts
```

The suite starts an isolated copy of this playground with its own local D1 database and drives it with Playwright. It covers every example signed out and signed in, both navigation modes, native and enhanced forms, redirects, boundaries, and session changes.
