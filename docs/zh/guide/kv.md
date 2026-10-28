---
outline: deep
---

# 键值存储 {#key-value-storage}

使用 `void/kv` 导出的 `kv` 读写 [Cloudflare Workers KV](https://developers.cloudflare.com/kv/) 中的数据。值以 JSON 格式存储，`kv.map()` 则可为同一集合指定独立的键前缀和值类型。

## 基本操作 {#basic-operations}

### 读取 {#get}

```ts
import { kv } from 'void/kv';

const user = await kv.get<User>('user:123');
// User | null
```

读取到的值会自动按 JSON 解析。如果存储的值不是有效的 JSON，则返回原始字符串。

### 写入 {#put}

```ts
await kv.put('user:123', { name: 'Alice', role: 'admin' });
```

所有值都会进行 JSON 序列化，字符串也不例外。读取时会保留原始类型，因此 `"123"` 或 `"null"` 这样的字符串在读取后仍然是字符串。

可以设置 TTL（单位为秒），或绝对过期时间（Unix 时间戳）：

```ts
await kv.put('session:abc', sessionData, { ttl: 3600 });
await kv.put('token:xyz', tokenData, { expiration: 1700000000 });
```

为键附加元数据：

```ts
await kv.put('user:123', userData, {
  metadata: { updatedBy: 'admin' },
});
```

### 删除 {#delete}

```ts
await kv.delete('user:123');
```

### 列出键 {#list}

```ts
const result = await kv.list({ prefix: 'user:' });
// { keys: [{ name: "user:1" }, { name: "user:2" }], list_complete: true }
```

使用 `limit` 和 `cursor` 分页：

```ts
const page = await kv.list({ prefix: 'user:', limit: 100 });
if (!page.list_complete) {
  const next = await kv.list({ prefix: 'user:', limit: 100, cursor: page.cursor });
}
```

### 连同元数据一起读取 {#get-with-metadata}

```ts
const result = await kv.getWithMetadata<User, { updatedBy: string }>('user:123');
// { value: User | null, metadata: { updatedBy: string } | null }
```

## 带类型的 Map {#typed-maps}

对于值类型相同的集合，使用 `kv.map()` 创建带有作用域和类型约束的客户端，并自动为键添加前缀：

```ts
const sessions = kv.map<Session>('sessions');

await sessions.put('abc', { userId: 1, token: '...' }, { ttl: 3600 });
// KV key: "sessions:abc"

const session = await sessions.get('abc');
// Session | null

await sessions.delete('abc');
```

Map 会自动为所有键添加 `"sessions:"` 前缀，并在列出键时移除该前缀：

```ts
const result = await sessions.list();
// keys: [{ name: "abc" }, { name: "def" }]  (prefix stripped)
```

Map 与基础客户端提供相同的方法（`get`、`put`、`delete`、`list`、`getWithMetadata`），同时具有值类型约束和自动添加前缀的能力。

如果需要执行此客户端未提供的操作，可以在路由处理函数中通过 `c.env.KV` 访问原始 `KVNamespace`。
