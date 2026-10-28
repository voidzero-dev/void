# 环境变量 {#environment-variables}

在 `env.ts` 中声明环境变量，然后通过 `void/env` 导出的 `env` 读取。本地值放在 `.env` 中，生产环境的服务端值通过 `void secret put` 设置。

## 定义 schema {#define-the-schema}

在项目根目录创建 `env.ts`：

```ts
import { defineEnv, number, string, url } from 'void/env';

export default defineEnv({
  DATABASE_URL: url(),
  STRIPE_KEY: string(),
  PORT: number().default(3000),
  VITE_API_ORIGIN: url(),
});
```

在应用中导入带有类型信息的 `env` 对象：

```ts
import { env } from 'void/env';

const databaseUrl = env.DATABASE_URL;
```

内置辅助函数包括 `string()`、`number()`、`boolean()`、`url()`、`email()`、`oneOf([...])` 和 `json<T>()`，均支持 `.optional()` 和 `.default(value)`。也可以直接使用任意兼容 [Standard Schema](https://standardschema.dev/) 的校验器。

默认值是写在源代码中的常量，适合用作非敏感配置的回退值。不要将凭据写入默认值。

## 本地开发 {#local-development}

将本地值统一放在项目根目录的一个 `.env` 文件中：

```ini
DATABASE_URL=postgres://localhost/my-app
STRIPE_KEY=sk_test_example
VITE_API_ORIGIN=http://localhost:5173
```

未加引号的值会在 `#` 处结束，因为这个符号表示注释的开始。值中包含 `#` 时应加上引号，例如 `DATABASE_URL="postgres://user:p#ss@localhost/my-app"`。

不要将 `.env` 提交到 Git。不支持其他 dotenv 文件，包括 `.env.local`、`.env.production`、`.env.example`，以及 Wrangler 的 `.dev.vars*`。

以 `__VOID_` 开头的名称由 Void 保留。如果在 `.env` 或 `env.ts` 中定义这类名称，Void 会报错并停止运行。

可随时运行本地检查：

```sh
void env check
```

本地数据库、迁移、身份认证和开发服务器工具都读取同一个 `.env` 文件。Shell 中的环境变量优先于文件中的值。

## 生产环境的服务端值 {#production-server-values}

schema 中没有客户端前缀的键都属于服务端值，可通过以下命令在远端设置：

```sh
void secret put DATABASE_URL
void secret put STRIPE_KEY
```

如需批量上传，先准备一个 dotenv 格式的文件，且文件中只包含生产环境的服务端值：

```sh
void secret sync production-secrets.txt
```

Secret 命令会在上传前按照 `env.ts` 校验值。生产环境的值会加密存储，并在 Worker 启动时再次校验。

Secret 命令会拒绝带客户端前缀的键。不要将本地开发凭据和 `VITE_*` 值放进生产环境的 Secret 文件。

`void deploy` 要求所有必需的服务端键都已存在于远端，不会上传 `.env` 中的值。

直接部署到 Cloudflare 时也使用相同的 Secret 命令。schema 中声明的服务端值必须保存为 Worker Secret，不能保存为明文 `vars`。

## 客户端值 {#client-values}

以 `VITE_` 开头的键都是客户端值，即使框架自定义了 Vite 的 `envPrefix` 也是如此。

客户端值会嵌入浏览器 JavaScript 中，不能当作 Secret。通过执行构建命令的 Shell 提供这些值，或在 schema 中设置默认值：

```sh
VITE_API_ORIGIN=https://api.example.com void deploy
```

```ts
export default defineEnv({
  VITE_API_ORIGIN: url().default('https://api.example.com'),
});
```

构建时会忽略 `.env` 中的客户端值，以免将开发者的本地值悄悄带入生产配置。

服务端渲染与浏览器使用相同的公开构建值。

## 校验与脱敏 {#validation-and-redaction}

```sh
void env check           # validate .env + shell for local development
void env check --remote  # validate build-time client values and remote server names
void env types           # regenerate .void/env.d.ts
```

无效值的诊断信息默认会隐藏输入值。只有明确要在本地调试时，才设置 `VOID_ENV_UNMASK=1`；关闭脱敏后，Void 会输出提示。

## 在 `env.ts` 中导入模块 {#imports-inside-env-ts}

在 `env.ts` 中使用相对导入或包名。不支持 TypeScript 路径别名，也不支持依赖 Vite 转换的导入。
