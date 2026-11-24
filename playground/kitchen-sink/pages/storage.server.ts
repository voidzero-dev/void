import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { storage } from 'void/storage';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const list = await storage.list({ limit: 20 });
  return {
    objects: list.objects.map((obj) => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
    })),
  };
});

export const action = defineHandler(async (c) => {
  const contentType = c.req.header('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.parseBody();
    const file = formData['file'] as File;
    if (file && file.size > 0) {
      await storage.put(file.name, file.stream(), {
        httpMetadata: { contentType: file.type },
      });
    }
  } else {
    // Delete via useForm (JSON)
    const body = await c.req.json<{ intent: string; key: string }>();
    if (body.intent === 'delete') {
      await storage.delete(body.key);
    }
  }
});
