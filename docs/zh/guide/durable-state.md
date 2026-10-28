---
outline: deep
---

# 持久状态 {#durable-state}

当多个请求需要通过同一个名称共享状态时，可以使用 Durable Object，例如购物车、房间或限流器。Void 提供类型化方法，并在各次调用之间保存对象状态。

在 `durable-objects/` 中创建模块，并使用 `defineDurableState()` 定义状态。Void 会为其提供一个以 SQLite 为存储后端的 Cloudflare Durable Object。此功能适用于部署在 Void 平台上的原生 Void 应用，也支持直接部署到 Cloudflare。

Void 添加资源后，请提交 `void.lock.json`，并保持其中已部署的迁移条目的原有顺序。

## 定义状态和方法 {#define-state-and-methods}

```ts
// durable-objects/counter.ts
import { defineDurableState } from 'void/durable';

export const Counter = defineDurableState({
  initialState: { count: 0 },
  methods: {
    increment(context, amount: number) {
      context.state.count += amount;
      return context.state.count;
    },
    read(context) {
      return context.state.count;
    },
  },
});

export default Counter;
```

将 `defineDurableState()` 返回的对象作为默认导出。

## 从路由调用 {#call-it-from-a-route}

导入定义，向 `get()` 传入名称来选择对象。方法参数和返回值都具有类型：

```ts
// routes/api/counter.ts
import { defineHandler } from 'void';
import { Counter } from '../../durable-objects/counter';

export const POST = defineHandler(async () => {
  const counter = Counter.get('global');
  const count = await counter.increment(1);
  return { count };
});
```

相同的名称始终对应同一个 Durable Object。如果你已经有 `DurableObjectId`，可以使用 `getById(id)`。在高级场景下，这两个辅助函数也都接受显式传入的 `DurableObjectNamespace` 作为第一个参数。

## 执行与持久化 {#execution-and-persistence}

Void 会在第一次操作前加载状态，并逐个执行 RPC 方法。方法、`fetch` 或 `alarm` 处理函数成功执行后，会保存更新后的状态。

如果处理函数执行失败或状态保存失败，Void 会将 `context.state` 恢复为之前的值。直接写入 `context.storage` 的数据不在此次回滚范围内。

每个方法都可以访问：

- `context.state`，可以修改或替换
- `context.env`，即 Durable Object 的环境
- `context.id` 和 `context.storage`
- `context.setAlarm()` 和 `context.deleteAlarm()`

`fetch`、`alarm` 和 `constructor` 是保留的方法名。请将 `fetch` 和 `alarm` 定义为顶层钩子：

```ts
export const Room = defineDurableState({
  initialState: { wakeups: 0 },
  methods: {},
  fetch(context) {
    return Response.json(context.state);
  },
  async alarm(context) {
    context.state.wakeups += 1;
    await context.setAlarm(Date.now() + 60_000);
  },
});

export default Room;
```

## 状态迁移 {#state-migrations}

持久化数据的结构发生变化时，请为其设置版本。版本号从 `1` 开始，必须连续。处理操作前，会先按顺序执行迁移，让操作使用迁移后的状态。

```ts
export const Counter = defineDurableState({
  initialState: { count: 0, label: 'Counter' },
  version: 2,
  migrations: [
    {
      version: 1,
      migrate(old) {
        return { count: (old as { count: number }).count, label: 'Counter' };
      },
    },
    {
      version: 2,
      migrate(old) {
        return { ...(old as { count: number; label: string }), label: 'Total' };
      },
    },
  ],
  methods: {
    read(context) {
      return context.state;
    },
  },
});

export default Counter;
```

状态迁移用于更新已保存的数据。Cloudflare 的类迁移与之独立，由 Void 在 `void.lock.json` 中管理。

直接部署到 Cloudflare 时，请勿在部署后删除 `void.lock.json` 中生成的 Durable Object 迁移，或调整其顺序。如果要在已有 Worker 上添加、重命名或移除类，请先审查迁移，再运行 `void deploy --platform cloudflare --atomic`。如果该 Worker 每次部署都需要原子发布，请在 `void.config.ts` 中设置 `deploy: { cloudflare: { mode: 'atomic' } }`。Cloudflare 会在一次部署中应用类的生命周期变更。在 Void 检查就绪状态前，Worker 就会开始接收流量，而且无法跨越这次迁移边界进行回滚。分阶段部署则保留了接收流量前的就绪检查。

## 重命名文件并保留状态 {#rename-a-file-while-keeping-its-state}

重命名已部署的定义文件前，先运行：

```sh
void info
```

对于 `durable-objects/counter.ts`，Void 会输出：

```text
To preserve this resource when moving its code, add this to 'defineDurableState':
  name: "counter",
```

将该属性添加到现有定义中：

```ts
export const Counter = defineDurableState({
  name: 'counter',
  initialState: { count: 0 },
  methods: {
    read(context) {
      return context.state.count;
    },
  },
});

export default Counter;
```

在 `durable-objects/` 内重命名文件，更新导入路径，然后部署。保持 `name: 'counter'` 和传给 `Counter.get()` 的名称不变，即可保留已存储的状态。

`name` 是可选项。请使用静态字符串，可以直接写在定义中，也可以定义为局部 `const`；字符串中的单词须以字母开头，例如 `'shopping-cart'`。不同名称必须生成不同的 Worker 类和绑定。修改已有资源的 `name` 会选择另一个资源。

如果已经移动了文件，`void info` 还会显示 `void.lock.json` 中有记录、但没有匹配定义的资源。请找出原来的资源，并使用其建议名称。如果无法给出建议名称，请从源码历史中恢复原文件，运行 `void info` 后再移动文件。保留现有锁文件和迁移历史。

## 部署支持 {#deployment-support}

类型化状态可用于本地开发、Void 平台，以及直接部署到 Cloudflare 的原生 Void 应用。部署到 Void 平台时使用 `void deploy`，部署到自己的 Cloudflare 账号时使用 `void deploy --platform cloudflare`。

在 Void 平台上，每个类的存储会在部署和回滚之间保留。回滚会恢复类的代码，但保留当前存储的数据。移除定义后，该类会停用；使用相同的资源名称重新添加定义，即可恢复对其数据的访问。删除项目会同时删除其 Durable Object 存储。

每个项目最多支持 32 个不同的自定义类，其中包括已移除但仍保留存储的类。请保持资源名称和实例名称稳定，以保留数据。如果使用的是较旧的 Void 安装版本，请先升级，再部署使用自定义 Durable Objects 的应用。

元框架以及 Node.js、Bun 和 Deno 不支持自定义 Durable Object 模块。

此功能与[类型化 WebSocket 路由](/zh/guide/websockets)相互独立。后者也使用以 SQLite 为存储后端的 Durable Objects，并同时支持直接部署到 Cloudflare 和托管的 Void 部署。

## 原生 Durable Object 类 {#native-durable-object-classes}

使用 `defineDurableObject` 可以保留原生 Cloudflare 类，包括继承 Cloudflare Agents 的类。Void 会发现其绑定并导出该类，不会替换其构造函数、生命周期或 RPC 方法。与持久状态一样，此功能支持 Void 平台和直接部署到 Cloudflare。

```ts
// durable-objects/workspace.ts
import { DurableObject } from 'cloudflare:workers';
import { defineDurableObject } from 'void/durable';

class WorkspaceObject extends DurableObject {
  async fetch() {
    return new Response('Workspace');
  }
}

export const Workspace = defineDurableObject({
  name: 'workspace',
  class: WorkspaceObject,
});
export default Workspace;
```

在服务端处理函数中调用 `Workspace.get('project-id')`，即可获得带类型的 stub。请在各次部署间保持资源名称和实例名称稳定，以保留存储。
