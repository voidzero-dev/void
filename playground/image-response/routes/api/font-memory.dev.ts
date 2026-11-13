import { defineHandler } from 'void';
import { fontCounts } from '../../src/font-memory.ts';

declare const __IMAGE_MEMORY_DEMO__: boolean;
const hint = 'Start this playground with vp run --filter ./playground/image-response dev:memory.';

export const GET = defineHandler(async (c) => {
  c.header('Cache-Control', 'no-store');
  if (!__IMAGE_MEMORY_DEMO__) {
    return c.json({ error: hint }, 503);
  }
  const { memorySample } = await import('../../src/font-memory.server.ts');
  return c.json(memorySample());
});

export const POST = defineHandler(async (c) => {
  c.header('Cache-Control', 'no-store');
  if (!__IMAGE_MEMORY_DEMO__) {
    return c.json({ error: hint }, 503);
  }
  const { collectGarbage, memorySample, renderFonts, stopRendering } =
    await import('../../src/font-memory.server.ts');
  const body = await c.req.json<{ action?: string; count?: number }>();
  if (body.action === 'stop') {
    stopRendering();
    return c.json(memorySample());
  }
  if (body.action === 'gc') {
    return c.json(await collectGarbage());
  }
  if (body.action !== 'warmup' && (body.action !== 'run' || !fontCounts.includes(body.count!))) {
    return c.json({ error: 'Choose a supported font count.' }, 400);
  }
  if (memorySample().running) {
    return c.json({ error: 'A batch is already running.' }, 409);
  }
  return c.json(
    await renderFonts(body.action === 'warmup' ? 5 : body.count!, body.action === 'warmup'),
  );
});
