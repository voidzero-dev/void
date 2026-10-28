---
outline: deep
---

# 插件与配置 {#plugin}

## `voidPlugin(options?)` {#voidplugin-options}

从 `"void"` 具名导出。返回一个 Vite 插件数组，用于配置基于文件的路由、迁移支持和 Cloudflare Workers 运行时。应用级配置从 [`void.config.ts`](/zh/reference/config) 读取；可选的 `options` 对象用于控制 Vite 和 Cloudflare 插件的行为。

```ts
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin()],
});
```

| 选项               | 类型                      | 说明                                                                                                                                                                                                                              |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistTo`        | `string`                  | 持久化本地开发状态（D1、KV、R2）的目录路径，默认为项目根目录下的 `.void/`。 |
| `auxiliaryWorkers` | `AuxiliaryWorkerConfig[]` | 开发时在同一 Miniflare 实例中运行的额外 Worker，此选项会透传给 `@cloudflare/vite-plugin`。适合让多个 Worker 共用绑定，例如在仪表盘之外运行独立的 API Worker。 |

## 项目配置 {#project-configuration}

### `defineConfig(config)` {#defineconfig-config}

在项目根目录的 `void.config.ts` 中，从 `void/config` 导入。此函数返回配置，并提供编辑器补全和 TypeScript 检查。Void 加载配置时还会校验结果，包括运行时计算出的值。

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: { name: 'my-app' },
  routing: { revalidate: 60 },
});
```

所有字段见[配置参考](/zh/reference/config)。
