---
description: 'Test a Void app with Vitest. With Vite+, run the tests through vp test.'
outline: deep
---

# Testing

Test your app with [Vitest](https://vitest.dev/). With Vite+, the default toolchain, run it with `vp test`:

```sh
vp test
```

Import test APIs from `vite-plus/test`. With the Vite toolchain, add `vitest` to your dev dependencies, run `vitest`, and import from `vitest` instead.

Vitest reads your `vite.config.ts`, so `void/*` imports, `@schema`, and the other modules Void provides resolve in tests as they do in your app. Tests need no separate configuration.

Keep test files out of the [convention directories](../reference/structure.md) such as `routes/` and `pages/`. Void reads the files there as part of your app, so a test file in `routes/` becomes a route. Put tests in `tests/`, or next to the code they test in `src/`.

## Bindings {#bindings}

Tests run in Node.js, not in the Workers runtime. Void doesn't start your Worker for a test run, so D1, KV, R2, and other bindings are unavailable, and it doesn't apply migrations to your local database. You can import modules that use bindings, but a call that reaches one throws `env: Cloudflare env is unavailable`.

To test code that uses a binding, replace its module with [`vi.mock()`](https://vitest.dev/api/vi#vi-mock):

```ts
// src/visits.ts
import { kv } from 'void/kv';

export async function countVisit(): Promise<number> {
  const visits = ((await kv.get<number>('visits')) ?? 0) + 1;
  await kv.put('visits', visits);
  return visits;
}
```

```ts
// src/visits.test.ts
import { expect, it, vi } from 'vite-plus/test';
import { countVisit } from './visits';

vi.mock('void/kv', () => {
  const values = new Map<string, unknown>();
  return {
    kv: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    },
  };
});

it('counts visits', async () => {
  await countVisit();
  expect(await countVisit()).toBe(2);
});
```

## Email {#email}

`void/email/testing` captures sent and received email in tests. See [Testing](./email/sending.md#testing) in Sending Email and [Testing inbound handlers](./email/receiving.md#testing-inbound-handlers) in Receiving Email.
