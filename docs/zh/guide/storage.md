---
outline: deep
---

# 对象存储 {#object-storage}

使用 `void/storage` 导出的 `storage` 将文件存储到 [Cloudflare R2](https://developers.cloudflare.com/r2/)。它提供带类型的 R2 API，用于上传、下载文件和操作元数据。

## 基本操作 {#basic-operations}

```ts
import { storage } from 'void/storage';

// Upload
await storage.put('uploads/photo.jpg', file, {
  httpMetadata: { contentType: 'image/jpeg' },
});

// Download
const object = await storage.get('uploads/photo.jpg');
if (object) {
  const data = await object.arrayBuffer();
}

// Delete
await storage.delete('uploads/photo.jpg');

// List
const listed = await storage.list({ prefix: 'uploads/' });
for (const obj of listed.objects) {
  console.log(obj.key, obj.size);
}

// Head (metadata only)
const head = await storage.head('uploads/photo.jpg');
```

`storage` 支持完整的 [R2Bucket API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。

## 提供文件访问 {#serving-files}

常见做法是通过 API 路由提供已上传文件的访问：

```ts
// routes/files/[key].ts
import { defineHandler } from 'void';
import { storage } from 'void/storage';

export const GET = defineHandler(async (c) => {
  const object = await storage.get(`uploads/${c.req.param('key')}`);

  if (!object) {
    return c.notFound();
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // Don't let an uploaded HTML or SVG file run as a page on your site.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Disposition', 'attachment');

  return new Response(object.body, { headers });
});
```

用户上传的文件可能包含 HTML 或脚本。应由服务端决定存储键，并在提供文件时设置 `nosniff` 和 `Content-Disposition: attachment`。`<img>`、`<video>` 标签仍可正常显示这些文件；直接打开文件 URL 则会下载文件。

## 自定义绑定 {#custom-bindings}

如果使用自己的 R2 绑定，或需要在测试中创建客户端，可以调用 `createStorage(bucket)`：

```ts
import { createStorage } from 'void/storage';

const storage = createStorage(env.MY_BUCKET);
```
