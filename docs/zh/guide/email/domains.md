---
outline: deep
---

# 邮件域名与配置 {#email-domains-and-setup}

根据部署目标选择配置方式：在 Void 平台上注册域名，或在自己的 Cloudflare 账号中配置邮件。使用平台共享发件地址时，请按[发送邮件](/zh/guide/email/sending#setup)配置。

## 在平台上使用自己的域名 {#your-own-domain-on-the-platform}

共享发件地址使用平台配置的邮件域名。要通过自己拥有的域名发信和收信，请将该域名所在的 Cloudflare DNS 区域（Zone）注册到项目：

```sh
void email domain add acme.com
```

`add` 会打开 Cloudflare API 令牌模板。创建前，请将令牌限制在选定账号和邮件区域；Workers Scripts 权限会作用于整个账号。你可以在 CLI 的隐藏输入提示中粘贴令牌，也可以使用刚复制的令牌；CLI 会要求你确认上述限制。平台会加密保存区域连接的凭据，因此共享该区域的项目无需各自部署独立的入站 Worker。

平台托管的自定义收信必须使用 Cloudflare DNS 区域的根域名（apex）。Cloudflare 的兜底规则只覆盖该根域名，因此选定区域的子域名无法接收发往任意地址的邮件。如果新的根域名已有 MX 记录，或其兜底规则已将邮件路由到其他地方，`add` 会拒绝注册，以免接管 Microsoft 365、Google Workspace 等其他提供方托管的邮件。请使用尚未配置邮件的根域名，或使用平台共享邮件地址。如果要保留根域名现有的邮件提供方，只通过平台发信，请让平台管理员将其注册为[仅发信域名](/zh/guide/platform/administration/email#sending-from-a-domain-that-already-receives-mail)。已经注册的根域名仍可再次运行 `add`，例如用于续期令牌。每个自定义根域名只能属于一个项目，一个项目可以注册多个根域名。

如果配置中断，重试前先使用 `void email domain status <domain>` 检查已保存的操作。

`void email domain status <domain>` 会分别报告三项独立结果：

- **Inbound（收信）**：邮件能否到达项目的处理函数。
- **Outbound（发信）**：发信是否已就绪、仅限已验证收件地址、仍在等待，或已被阻断。
- **Management（管理）**：已保存的 Cloudflare 凭据能否管理该连接。

使用 `void email domain sync <domain>` 完成配置并刷新就绪状态。状态信息会列出仍需在控制台执行或补充凭据的步骤。收信就绪后，可用 `rotate-secret` 轮换连接密钥，或用 `remove` 解除域名关联。请在 Cloudflare 中撤销不再使用的 API 令牌。见[邮件域名命令](/zh/reference/cli/email#void-email-domain)。

收信就绪后，发往该域名下任意地址的邮件都会到达 `email/` 处理函数。向任意收件人发信还需要发信功能就绪；如果域名仍被限制为只能向已验证的地址发信，就仍需验证收件人。平台配额和暂停限制同时适用于共享发件地址和自定义发件地址。

在由管理员管理域名的平台上，为新域名运行 `add` 会输出管理员需要执行的命令。已有、由项目所有者管理的连接仍可由该所有者使用。管理员可能允许共享发件地址向指定收件域名或任意收件人发信，但发往平台共享邮件域名的地址仍需明确验证。

## 使用自己的 Cloudflare 账号 {#your-own-cloudflare-account}

在自己拥有的 Cloudflare DNS 区域中配置发件人：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  email: { from: 'Acme <support@mail.acme.com>' },
});
```

使用邮件子域名，可以让 `acme.com` 上已有的邮件继续由当前提供方托管。Void 会拒绝替换其他提供方的 MX 记录。

### 配置 {#setup-1}

通过 `void cloudflare login` 登录，或使用除部署权限外还具有 **Email Routing Edit（邮件路由编辑）** 和 **Email Sending Edit（邮件发送编辑）** 权限的 `CLOUDFLARE_API_TOKEN`。如果浏览器登录会话缺少邮件权限，请退出后重新登录。不支持全局 API 密钥（Global API Keys）。

运行 `void deploy --platform cloudflare`。Void 会展示准备配置的域名、路由、发信、DNS 和处理函数地址。确认后会配置邮件并部署，后续部署会复用该设置。如果拒绝首次配置，应用仍会部署，但不启用邮件。

未设置 `email.from` 时，Void 会跳过自动配置，保留你自行编写的 `cloudflare.send_email` 绑定和 `cloudflare.addresses`，需要你自行检查就绪状态。如果无法验证自动配置，`--require-email` 仍会拒绝部署。

如果子域名配置需要在控制台操作，请按 **Email → Settings → Subdomains（邮件 → 设置 → 子域名）** 下的清单完成后重试。DNS 变更后，通过以下命令检查就绪状态：

```sh
void email status --platform cloudflare
```

### 收件地址 {#inbound-addresses}

将 `email.from` 设置在 `mail.acme.com` 上时，处理函数可接收以下地址的邮件：

| 处理函数 | 子域名地址 | 区域根域名地址 |
| --- | --- | --- |
| `support.ts`, `support+[ticket].ts` | `support@mail.acme.com` | `support@acme.com` |
| `_default.ts` | 不创建兜底规则 | `*@acme.com` |
| `[user].ts`, `[user]+[tag].ts` | 不支持 | `*@acme.com` |

Cloudflare 的兜底规则只覆盖区域根域名。在子域名上，`_default.ts` 可以处理通过显式规则接收的邮件，但不能接收发往任意地址的邮件。

配置会启用该区域的加号地址功能，让发往 `support+T-42@mail.acme.com` 的邮件到达 `support+[ticket].ts`。此设置也适用于根域名和其他子域名。

`replyEmail()` 默认以原邮件的收件地址作为发件人。转发需要使用已在 Cloudflare 验证的目标地址。

### 发信 {#sending}

在 Workers Free 上，`sendEmail()` 可以向 Cloudflare 中 **Email Routing → Destination addresses（邮件路由 → 目标地址）** 列出的已验证地址发信。

按照 [Cloudflare 邮件身份验证指南](https://developers.cloudflare.com/email-service/concepts/email-authentication/)配置发件域名的 SPF、DKIM 和 DMARC 记录，再检查收到邮件的原始头部中的验证结果。`sendEmail()` 成功只表示服务提供方已接受邮件，不代表投递成功，也不代表邮件身份验证已就绪。

向任意收件人发信，需要 [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) 并完成 Email Sending 开通流程。升级后，运行 `void email setup --platform cloudflare`。普通部署不会重新尝试开通。

已有的 DMARC 或退信域名记录可能阻止开通，检查清单会指出需要解决的冲突。收信仍然可用。

`void email usage`、`logs`、`destinations`、`allow` 和 `disallow` 命令适用于 Void 平台。

### 配置变更 {#configuration-changes}

配置后，请提交 `void.lock.json`。Void 会根据处理函数推导收件路由地址，并在部署时创建对应规则。

其他 Worker 或转发服务拥有的现有规则会保留。如果自行管理 `cloudflare.addresses`，请按检查清单操作，不要与邮件自动配置混用。

删除处理函数后，请检查报告中已过时的地址，并设置所需的 `cloudflare.addresses`。删除收件路由规则需要在交互式终端中确认。

要移除全部邮件配置，请从 `void.lock.json` 的 `resolved` 中移除 `addresses`、`send_email` 和 `vars.__VOID_EMAIL_FROM`，移除 `void.config.ts` 中对应的覆盖设置，并删除 Cloudflare 中的收件路由规则。

### CI {#ci}

先在本地配置邮件：

```sh
void email setup --platform cloudflare
void email status --platform cloudflare
```

提交 `void.lock.json`，再在 CI 中运行：

```sh
void deploy --platform cloudflare --require-email
```

CI 无法回答配置提示。未使用 `--require-email` 时，尚未配置的应用可以在不启用邮件的情况下部署。如果已保存配置，但 DNS 尚未传播，则需稍后重试部署。Workers Free 上面向已验证收件人的配置也能满足 `--require-email`。
