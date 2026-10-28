---
outline: deep
---

<script setup>
import LegacyDocRedirect from '../../.vitepress/theme/LegacyDocRedirect.vue';
import links from '../../.vitepress/redirects/guide-email.json';

const zhLinks = Object.fromEntries(
  Object.entries(links).map(([anchor, target]) => [anchor, `/zh${target}`]),
);
</script>

<LegacyDocRedirect page="zh/guide/email.md" :links="zhLinks" />

# 电子邮件 {#email}

使用 Void，你可以发送事务性邮件、在路由处理函数中接收邮件，也可以通过本地收件箱测试邮件发送。

| 指南 | 主要内容 |
| --- | --- |
| [发送邮件](/zh/guide/email/sending) | 发送邮件和附件、处理错误，以及在本地测试邮件投递。 |
| [接收邮件](/zh/guide/email/receiving) | 将收到的邮件交给路由处理函数处理，以及回复、转发和本地测试。 |
| [域名与配置](/zh/guide/email/domains) | 在平台上注册邮件域名，或配置自己的 Cloudflare 账号。 |

如果你的 Void 平台已经启用邮件功能，可以先使用平台的[共享发件地址](/zh/guide/email/sending#setup)。如果直接部署到 Cloudflare，则需要先[配置发件地址和域名](/zh/guide/email/domains#your-own-cloudflare-account)。
