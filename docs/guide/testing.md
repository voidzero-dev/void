---
description: 'Run tests with Vitest and Vite+, mock Cloudflare bindings, and test email with the built-in harnesses.'
outline: deep
---

# Testing

Void apps use [Vitest](https://vitest.dev/). With Vite+, run your tests with:

```sh
vp test
```

Import `it`, `expect`, and other test APIs from `vite-plus/test`. If you chose Vite instead of Vite+, install `vitest` as a dev dependency and use `vitest` for both the imports and command.

Vitest uses your `vite.config.ts`. Imports such as `void/*` and `@schema` work without extra test configuration.

Put tests in `tests/` or beside the code they test in `src/`. Keep them out of [convention directories](../reference/structure.md) such as `routes/` and `pages/`, where Void would treat them as app routes.

## Bindings {#bindings}

Tests run in Node.js without starting a Worker or applying local migrations. To test code that uses D1, KV, R2, or another binding, mock the module with [`vi.mock()`](https://vitest.dev/api/vi#vi-mock).

For example, this function counts visits in KV:

```ts
// src/visits.ts
import { kv } from 'void/kv';

export async function countVisit(): Promise<number> {
  const visits = ((await kv.get<number>('visits')) ?? 0) + 1;
  await kv.put('visits', visits);
  return visits;
}
```

Replace KV with an in-memory map in the test:

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
