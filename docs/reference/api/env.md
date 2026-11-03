---
outline: deep
---

# Environment Variables {#environment}

Imported from `"void/env"`.

## `defineEnv(schema)` {#defineenv-schema}

Register an env schema and return the typed [`env`](#env) proxy. Void auto-discovers `env.ts`, imports it during dev/build/deploy, generates `.void/env.d.ts`, validates production secrets before deploy, and validates values at worker boot.

```ts
import { defineEnv, string, number, oneOf, url } from 'void/env';

export default defineEnv({
  STRIPE_KEY: string(),
  PORT: number().default(3000),
  NODE_ENV: oneOf(['development', 'production']),
  VITE_PUBLIC_URL: url(),
});
```

## `env` {#env}

Typed runtime proxy for declared env keys. Unknown keys and bindings pass through as `unknown`.

```ts
import { env } from 'void/env';

const port = env.PORT;
```

## Schema helpers {#schema-helpers}

`void/env` includes Standard Schema-compatible helpers: `string()`, `number()`, `boolean()`, `url()`, `email()`, `oneOf([...])`, and `json<T>()`. Each helper supports `.optional()` and `.default(value)`.

Non-client keys are server values and use remote secret storage in production. `VITE_*` keys are public build-time client values. Invalid input is redacted uniformly; storage is not selected with schema modifiers.

## Types {#types-1}

`void/env` also provides global Cloudflare environment types:

```ts
/// <reference types="void/env" />
```

Declares the `Cloudflare.Env` namespace with `DB`, `KV`, `STORAGE`, `AI`, `SANDBOX`, and `ASSETS` binding types.

For handler context variables such as `c.set()` and `c.get()`, augment [`CloudContextVariables`](./types.md#cloudcontextvariables). This is separate from `Cloudflare.Env`, which types worker bindings. Framework adapters such as `@void/vue`, `@void/react`, and `@void/svelte` also augment `CloudContextVariables` to add the `shared` key used by `useShared()`.
