---
outline: deep
---

# 发送邮件 {#sending-email}

使用 `sendEmail` 发送事务性邮件。开发期间，Void 会将邮件捕获到本地收件箱中。

```ts
import { sendEmail } from 'void/email';

const result = await sendEmail({
  from: 'Acme <acme+noreply@mail.example.com>', // use your project's sender address
  to: 'user@example.com',
  subject: 'Welcome',
  text: 'Thanks for signing up!',
  // html: '<p>Thanks for signing up!</p>', // optional — sent as multipart/alternative when paired with text
});

if (!result.ok) {
  if ('error' in result) {
    // A request-level failure; OUTCOME_UNKNOWN may already have been submitted.
    console.error(result.error.code, result.error.message);
  } else {
    // Some recipients failed. `deliveries` says which.
    for (const d of result.deliveries.filter((d) => !d.ok)) {
      console.error(d.recipient, d.error.code, d.error.message);
    }
  }
}
```

需要检查两种失败结果：`result.error` 表示请求级错误，`result.deliveries` 则报告各个收件人的错误。收件地址未经验证时，错误会出现在 `deliveries` 中。

## 配置 {#setup}

在已启用邮件功能的平台上，部署时无需额外配置邮件功能。请向管理员获取平台的共享邮件域名。管理员可[在安装或升级时启用邮件功能](/zh/guide/platform/installation/credentials#enable-email)。

在启用了邮件功能的平台上，每个项目都具备：

- **默认发件地址：**`<your-slug>+noreply@<mail-domain>`。对于 slug 超过 56 个字符的旧项目，必须显式传入 `from`。
- **作为收件地址的账号邮箱：**创建项目时会自动注册此地址。若 Cloudflare 尚未为该平台验证此地址，请点击邮件中的验证链接，并在向该地址发送邮件前运行 `void email destinations`。

共享发件地址只能向已验证的收件地址发送邮件。发送前，请先验证自己的邮箱，或[添加其他收件地址](#adding-recipients)。

如果改为部署到自己的 Cloudflare 账号（`void deploy --platform cloudflare`），则需要在 `void.config.ts` 中配置发件地址并完成邮件设置，详见[使用自己的 Cloudflare 账号](/zh/guide/email/domains#your-own-cloudflare-account)。

## 添加收件地址 {#adding-recipients}

Cloudflare 的 `send_email` 绑定只能向已注册的收件地址投递邮件。使用 CLI 添加地址：

```sh
void email allow user@acme.com
```

Cloudflare 会向收件人发送包含验证链接的邮件。收件人点击链接，且 `void email destinations` 同步到验证结果后，项目就可以向该地址发送邮件了。如果未收到链接或链接已过期，可在地址仍处于待验证状态时再次运行 `void email allow <address>`。CLI 会重新发送链接，或告知你如何获取新链接。列出项目的收件地址：

```sh
void email destinations
```

::: warning 适用场景
共享发件地址适合团队提醒、项目通知和回复收到的邮件。

如果需要向任意用户发送邮件，请[注册自己的域名](/zh/guide/email/domains#your-own-domain-on-the-platform)、[在自己的 Cloudflare 账号上使用 Workers Paid](/zh/guide/email/domains#your-own-cloudflare-account)，或在处理函数中调用其他邮件提供商。
:::

## 选项 {#options}

| 选项             | 类型                         | 说明                                                                                                           |
| ---------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `from`           | `string \| { email, name? }` | 可选。限定为项目的发件地址，详见下文。                                                                          |
| `to`             | `Address \| Address[]`       | 必填。一个或多个收件地址。                                                                                     |
| `subject`        | `string`                     | 必填。支持 UTF-8（按 RFC 2047 编码）。                                                                         |
| `text`           | `string`                     | `text` / `html` 至少需要提供一项。                                                                             |
| `html`           | `string`                     | 同时提供两项时，以 `multipart/alternative` 格式发送。                                                          |
| `replyTo`        | `Address`                    | 可选的 `Reply-To` 邮件头。                                                                                    |
| `cc`, `bcc`      | `Address \| Address[]`       | 可选。每个收件地址都使用独立的邮件信封发送。                                                                    |
| `headers`        | `Record<string, string>`     | 自定义邮件头；系统保留的邮件头（From、Date 等）会被忽略。                                                      |
| `attachments`    | `Attachment[]`               | 参见[附件](#attachments)。                                                                                    |
| `idempotencyKey` | `string`                     | 在 Void 平台上可选：由 1–128 个可打印的非空格 ASCII 字符组成。重试同一次发送时复用此键。                        |

`to`、`cc` 和 `bcc` 合计最多可包含 50 个收件地址。请使用本地部分为 ASCII 字符的标准邮箱地址；国际化域名应使用 punycode。

`Address` 接受字符串（`"hello@acme.dev"` 或 `"Name <hello@acme.dev>"`），也接受对象（`{ email, name? }`）。显示名称支持 Unicode。

在平台上，发件地址限定在你的项目范围内。`from` 必须是项目自己的平台地址：`<project-slug>@<mail-domain>` 或 `<project-slug>+<tag>@<mail-domain>`，可附带显示名称；也可以使用通过 `void email domain add` 注册的域名下的任意地址（参见[在平台上使用自己的域名](/zh/guide/email/domains#your-own-domain-on-the-platform)）。例如，平台的邮件域名为 `mail.example.com` 时，可以使用 `Acme <acme+noreply@mail.example.com>`。其他地址都会被拒绝，并返回 `INVALID_FROM`。省略 `from` 时，Void 会自动填入 `<project-slug>+noreply@<mail-domain>`。如果项目所有者设置了[邮件别名](/zh/reference/cli/email#void-email-alias)，也可以使用 `<alias>@<mail-domain>` 和 `<alias>+<tag>@<mail-domain>`；默认地址仍然使用 slug。

使用自己的 Cloudflare 账号时，`from` 默认取自 `void.config.ts` 中的 `email.from`，且必须属于该账号有权用于发送邮件的域名。Cloudflare 会拒绝其他发件地址，`sendEmail` 会将其报告为 `INVALID_FROM`。

## 附件 {#attachments}

```ts
await sendEmail({
  to: 'user@example.com',
  subject: 'Your receipt',
  text: 'Receipt attached.',
  attachments: [
    {
      filename: 'receipt.pdf',
      content: pdfBytes, // string | Uint8Array | ArrayBuffer | Blob
      contentType: 'application/pdf',
    },
  ],
});
```

对于内嵌图片（例如 HTML 中引用的 logo），请设置 `disposition: 'inline'` 和 `contentId`：

```ts
await sendEmail({
  to: 'user@example.com',
  subject: 'Hello',
  html: '<img src="cid:logo" alt="Acme">',
  attachments: [
    {
      filename: 'logo.png',
      content: logoBytes,
      contentType: 'image/png',
      contentId: 'logo',
      disposition: 'inline',
    },
  ],
});
```

如果省略 `contentType`，Void 会根据文件名推断其值。显式指定的值必须是有效的媒体类型。`contentId` 用于标识 HTML 中通过 `cid:<id>` 引用的图片，可使用 `logo` 或 `logo@acme.dev` 这样的 ID。编码后的邮件大小上限为 5 MiB，自定义邮件头的大小上限为 16 KiB。附件字段无效或邮件超出大小限制时，会返回 `MIME_ERROR`。

## 结果与错误 {#result-and-errors}

`sendEmail` 会返回结果，而不会抛出异常。结果成功表示提供商已接受发送请求，并不代表邮件已经投递到收件人的邮箱。

`ok: true` 的结果包含收件人 ID。失败结果则包含请求级 `error` 或按收件人返回的 `deliveries`。平台结果会在可用时包含 `operationId`。

超时可能返回 `OUTCOME_UNKNOWN`；提供商仍有可能接受该邮件。重试前，请先检查发送结果。

对于可能需要重试的发送操作，请使用幂等键：

```ts
const result = await sendEmail({
  to: 'user@example.com',
  subject: 'Invoice ready',
  text: 'Your invoice is available in your account.',
  idempotencyKey: 'invoice:42:ready',
});

if (result.ok) {
  console.log('Accepted by the provider', result.operationId);
} else {
  console.log('Inspect the outcome before retrying', result.operationId, result);
}
```

在 30 天内，使用相同的键和相同的请求内容重复请求，会返回已记录的结果，不会再次向提供商提交。使用相同的键但传入不同的请求内容，会返回 `IDEMPOTENCY_CONFLICT`。响应丢失或发往提供商的请求中断时，可能返回 `OUTCOME_UNKNOWN`；请检查 `void email logs`，或使用相同的键再次请求。新键会创建新的发送操作，可能导致重复发送。通过原生 Cloudflare 绑定发送时，不支持平台幂等键。

| 错误码                   | 含义                                                           |
| ------------------------ | -------------------------------------------------------------- |
| `BINDING_MISSING`        | 未配置邮件传输通道。                                          |
| `INVALID_FROM`           | 发件地址无效，或项目无权使用该地址。                           |
| `INVALID_TO`             | 收件地址列表无效，或超过 50 个收件地址。                       |
| `UNVERIFIED_DESTINATION` | 当前策略要求验证该收件地址。                                  |
| `MIME_ERROR`             | 邮件无效，或超出大小限制。                                     |
| `QUOTA_EXCEEDED`         | 已达到平台或提供商的配额上限。                                 |
| `IDEMPOTENCY_CONFLICT`   | 此键已用于不同的请求内容。                                    |
| `OUTCOME_UNKNOWN`        | 发送请求可能已到达提供商；请勿盲目重新发送。                    |
| `UPSTREAM_ERROR`         | 提供商或平台拒绝了请求。                                       |

平台默认按收件地址计算发送尝试次数：每个 UTC 自然月 200 次，任意连续一分钟内 10 次。失败或结果不确定的尝试也可能计入这些限额。运行 `void email usage` 查看当前额度。

`void email usage` 会显示当月按收件地址计算的发送尝试次数、收到的邮件数量以及剩余额度。使用 `void email logs --limit 50` 可以查看最近的元数据记录，单次最多支持 100 条，记录保留 30 天，内容包括操作、收件人、方向、状态、提供商引用和错误码。它不会存储邮件主题、正文或附件。接收邮件和发送回复是两个独立事件。

## 本地开发 {#local-development}

本地开发期间，发送的邮件会被捕获到内存中的收件箱，不会发送到 Cloudflare。开发服务器启动时会打印收件箱 URL：

```
[void] Email inbox: http://localhost:5173/__void/inbox?token=<printed-token>
```

打开邮件后，可以预览 HTML、查看附件，或将邮件下载为 `.eml` 文件。

所有收件箱路由都需要本地访问令牌。Void 会将令牌包含在打印出的收件箱 URL 和浏览器链接中。通过命令行请求时，请按下方示例在 `x-void-dev-trigger` 请求头中发送令牌；未提供令牌的请求会返回 `401`。令牌保存在 `.void/dev-trigger-token` 中。请将收件箱 URL 视为凭据，尤其是在将开发服务器开放到网络时。

```bash
# download a message as .eml
curl http://localhost:5173/__void/inbox/<id>/raw \
  -H "x-void-dev-trigger: <printed-token>" -o message.eml

# clear the inbox
curl -X DELETE http://localhost:5173/__void/inbox \
  -H "x-void-dev-trigger: <printed-token>"
```

收件箱会在 HMR 期间保留最近的 100 封邮件，并在服务器完全重启时清空。

开发收件箱支持原生 Void 应用、TanStack Start 和 React Router。SvelteKit、Nuxt、Analog 和 Astro 不支持此功能；这些应用发送邮件时会返回 `BINDING_MISSING`。测试时，可使用 `void/email/testing` 中的 `createEmailTestHarness` 捕获发送的邮件。如果已配置的收件箱无法访问，`sendEmail` 会返回 `UPSTREAM_ERROR`，且不会发送邮件。

`sendInDev` 已弃用。本地开发时，它会跳过收件箱并返回 `BINDING_MISSING`，因此始终不会投递邮件。请移除此选项，并部署应用来测试实际投递。

## 测试 {#testing}

使用测试工具检查发出的邮件，无需模拟绑定：

```ts
import { describe, it, expect } from 'vitest';
import { sendEmail } from 'void/email';
import { createEmailTestHarness } from 'void/email/testing';

describe('signup flow', () => {
  it('sends a welcome email', async () => {
    const inbox = createEmailTestHarness();

    await sendEmail({
      from: 'acme+noreply@mail.example.com', // use your project sender
      to: 'user@example.com',
      subject: 'Welcome',
      text: 'Hi!',
    });

    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].subject).toBe('Welcome');
    inbox.dispose();
  });
});
```

测试工具会拦截每次 `sendEmail` 调用，直到调用 `dispose()`。`clear()` 会清空已捕获的邮件列表，但仍会继续拦截发送。

关于如何处理收到的邮件，请参见[接收邮件](/zh/guide/email/receiving)。
