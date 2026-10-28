---
outline: deep
---

# 接收邮件 {#inbound}

在顶层 `email/` 目录中定义收件处理函数，即可接收邮件。收件处理函数要求使用原生 Void 应用，元框架构建以及 Node.js、Bun 或 Deno 构建均不支持。

```ts
// email/_default.ts — fallback for any unmatched recipient
import { defineEmail, parseEmail } from 'void/email';

export default defineEmail(async (message, env, ctx) => {
  const parsed = await parseEmail(message);

  if (parsed.subject?.startsWith('STOP')) {
    message.setReject('Use the unsubscribe link.');
    return;
  }

  await message.forward('archive@example.com');
});
```

处理函数接收 Cloudflare 原生的 `ForwardableEmailMessage`，以及可选的第四个参数 `info`。动态路由段和带标签的路由段会将匹配值填入 `params`：

| 方法 | 用途 |
| --- | --- |
| `message.setReject(reason)` | 以 SMTP 错误拒收邮件。 |
| `message.forward(to, headers?)` | 转发到已验证的收件地址。 |
| `replyEmail(message, options)` | 在同一邮件会话中回复。 |
| `message.reply({ from, to, raw })` | 使用自行提供的 MIME 字节或流回复。 |

处理函数未执行任何操作就返回时，表示接受该邮件。传给 `forward` 和 `message.reply` 的地址应为不带显示名称的邮箱地址。

`parseEmail(message)` 返回 `from`、`to`、`subject`、`text`、`html`、`attachments` 和 `headers`。每封邮件最多调用一次，因为底层流只能读取一次。

## 按收件地址路由 {#per-recipient-routing}

```
email/
  support.ts                — handles support@<your-domain>
  billing.ts                — handles billing@<your-domain>
  support+[ticket].ts       — handles support+ticket-123@... → info.params.ticket = "ticket-123"
  support+vip.ts            — handles exactly support+vip@..., ahead of support+[ticket].ts
  [user].ts                 — dynamic local-part   → info.params.user
  [user]+[tag].ts           — dynamic + subaddress → info.params.user, info.params.tag
  _default.ts               — fallback when no per-address pattern matches
```

文件按 `To` 地址的本地部分（即 `@` 之前的部分）匹配，不区分大小写。**匹配优先级如下，越具体的规则越优先：**

1. `support+vip.ts`（静态名称 + 字面标签）
2. `support+[ticket].ts`（静态名称 + 捕获标签）
3. `support.ts`（静态名称）
4. `[user]+vip.ts`（动态名称 + 字面标签）
5. `[user]+[tag].ts`（动态名称 + 捕获标签）
6. `[user].ts`（动态名称）
7. `_default.ts`（兜底）

使用第一条匹配的规则。同类匹配模式中，字面标签优先于捕获标签：`support+vip@` 会交给 `support+vip.ts`，其他所有 `support+…@` 则交给 `support+[ticket].ts`。匹配模式结构相同的处理函数会按字母顺序依次尝试。

如果没有规则匹配，也没有 `_default.ts`，控制权会交还 Cloudflare，发件人会收到未投递报告。`email/` 下的嵌套目录会被忽略，因为收件地址是单个字符串，而不是路径。

## 在同一邮件会话中回复 {#threaded-replies}

```ts
// email/support+[ticket].ts
import { defineEmail, parseEmail, replyEmail } from 'void/email';

export default defineEmail(async (message, env, ctx, info) => {
  const parsed = await parseEmail(message);
  await ticketStore.append(info!.params.ticket, parsed.text ?? '');

  await replyEmail(message, {
    text: `Got your message on ticket ${info!.params.ticket}.`,
  });
});
```

`replyEmail()` 会使用保留会话关联的主题回复原发件人。你也可以覆盖 `subject`。

在 Void 平台上，默认发件地址是项目的共享地址，或已注册域名上收到该邮件的地址。共享邮件请使用该默认值；`message.to` 中已经移除了项目前缀。覆盖发件地址时，只能使用属于本项目的地址。

回复遵循项目的收件人策略。使用 `void email allow <address>` 验证共享发件地址的收件人。处理函数执行结束后，可以通过 `void email logs` 查看邮件提供商返回的结果。

转发要求原生 Cloudflare 邮件事件。对于由平台中转的自定义域名邮件，请改用回复。

## 配置入站邮件投递 {#configuring-inbound-delivery}

在已启用邮件的平台上，平台验证收件规则并启用加号地址后，发往 `<slug>+anything@<mail domain>` 的邮件就会交给已部署的 `email/` 处理函数，无需为每个项目单独配置 DNS。Void 会在部署处理函数时配置该规则；创建项目或仅发送邮件不需要入站规则。如果无法完成配置，部署会报告路由冲突或容量限制。[已注册的自定义域名](/zh/guide/email/domains#your-own-domain-on-the-platform)在入站就绪状态变为 `ready` 后，也会将邮件交给这些处理函数。使用 `void email domain status` 可以查看提供商当前的路由状态，以及尚需完成的配置步骤。

配置了[邮件别名](/zh/reference/cli/email#void-email-alias)的项目，也可以通过 `<alias>+anything@<mail domain>` 收信。路由不区分使用了哪种前缀：项目 slug 为 `acme-store`、别名为 `acme` 时，`acme-store+support@…` 和 `acme+support@…` 都会交给 `email/support.ts`。

直接部署时，请按[自己的 Cloudflare 账号](/zh/guide/email/domains#your-own-cloudflare-account)中的说明配置收件地址。

本地开发服务器提供用于查看发出邮件的收件箱，但没有入站邮件触发器。请使用下文的 `createInboundTestHarness` 测试收件处理函数。

## 测试收件处理函数 {#testing-inbound-handlers}

使用 `createInboundTestHarness` 捕获回复、转发和拒收操作。测试平台共享邮件时，请传入包含项目前缀的完整地址，例如 [`acme+support+abc-123@acme.dev`](mailto:acme+support+abc-123@acme.dev)。测试直接部署到 Cloudflare 的邮件时，请设置 `slug: null`，并使用 [`support+abc-123@mail.acme.com`](mailto:support+abc-123@mail.acme.com)。

```ts
import { describe, it, expect } from 'vitest';
import { createInboundTestHarness } from 'void/email/testing';
import defaultHandler from './email/_default';
import support from './email/support+[ticket]';

describe('email handlers', () => {
  it('routes to support+[ticket] and extracts the tag', async () => {
    const harness = createInboundTestHarness({
      routes: { 'support+[ticket]': support, _default: defaultHandler },
    });
    const result = await harness.deliver({
      from: 'user@example.com',
      to: 'acme+support+abc-123@acme.dev',
      subject: 'Help',
      text: 'I have a problem',
    });
    expect(result.handler).toBe('support+[ticket]');
    expect(result.params).toEqual({ ticket: 'abc-123' });
  });

  it('rejects STOP messages via _default', async () => {
    const harness = createInboundTestHarness({ routes: { _default: defaultHandler } });
    await harness.deliver({
      from: 'user@example.com',
      to: 'acme+unknown@acme.dev',
      subject: 'STOP',
      text: 'bye',
    });
    expect(harness.rejects).toEqual(['Use the unsubscribe link.']);
  });
});
```

测试工具匹配处理函数的顺序，与已部署的邮件路由相同。
