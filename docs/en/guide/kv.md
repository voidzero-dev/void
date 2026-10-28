---
outline: deep
---

# Key-Value Storage

Read and write data in [Cloudflare Workers KV](https://developers.cloudflare.com/kv/) with `kv` from `void/kv`. Values are stored as JSON, and `kv.map()` gives a collection its own key prefix and value type.

## Basic Operations

### Get

```ts
import { kv } from 'void/kv';

const user = await kv.get<User>('user:123');
// User | null
```

Values are automatically parsed as JSON. If the stored value isn't valid JSON, the raw string is returned.

### Put

```ts
await kv.put('user:123', { name: 'Alice', role: 'admin' });
```

Values, including strings, are JSON-serialized. Reads preserve their types, so a string such as `"123"` or `"null"` comes back as a string.

Add a TTL (in seconds) or absolute expiration (Unix timestamp):

```ts
await kv.put('session:abc', sessionData, { ttl: 3600 });
await kv.put('token:xyz', tokenData, { expiration: 1700000000 });
```

Attach metadata to a key:

```ts
await kv.put('user:123', userData, {
  metadata: { updatedBy: 'admin' },
});
```

### Delete

```ts
await kv.delete('user:123');
```

### List

```ts
const result = await kv.list({ prefix: 'user:' });
// { keys: [{ name: "user:1" }, { name: "user:2" }], list_complete: true }
```

Paginate with `limit` and `cursor`:

```ts
const page = await kv.list({ prefix: 'user:', limit: 100 });
if (!page.list_complete) {
  const next = await kv.list({ prefix: 'user:', limit: 100, cursor: page.cursor });
}
```

### Get with Metadata

```ts
const result = await kv.getWithMetadata<User, { updatedBy: string }>('user:123');
// { value: User | null, metadata: { updatedBy: string } | null }
```

## Typed Maps

For collections of the same type, use `kv.map()` to create a scoped, typed client with automatic key prefixing:

```ts
const sessions = kv.map<Session>('sessions');

await sessions.put('abc', { userId: 1, token: '...' }, { ttl: 3600 });
// KV key: "sessions:abc"

const session = await sessions.get('abc');
// Session | null

await sessions.delete('abc');
```

The map automatically prefixes all keys with `"sessions:"` and strips the prefix when listing:

```ts
const result = await sessions.list();
// keys: [{ name: "abc" }, { name: "def" }]  (prefix stripped)
```

Maps have the same methods as the base client (`get`, `put`, `delete`, `list`, `getWithMetadata`) but with a typed value and automatic prefixing.

For operations beyond this client, access the raw `KVNamespace` through `c.env.KV` in a route handler.
