import { defineHandler } from 'void';
import { kv } from 'void/kv';
import { storage } from 'void/storage';

const D1_TABLES_TO_CLEAR = [
  'notes',
  'queue_results',
  'verification',
  'session',
  'account',
  'user',
] as const;

export const POST = defineHandler(async (c) => {
  // Clear all app + auth D1 tables, but tolerate fresh environments where
  // some tables may not exist yet.
  const existingTableRows =
    (
      await c.env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${D1_TABLES_TO_CLEAR.map(
          (name) => `'${name}'`,
        ).join(', ')})`,
      ).all()
    ).results ?? [];
  const existingTables = new Set(existingTableRows.map((row) => String(row.name)));
  const deleteStatements = D1_TABLES_TO_CLEAR.flatMap((name) =>
    existingTables.has(name) ? [c.env.DB.prepare(`DELETE FROM "${name}"`)] : [],
  );
  if (deleteStatements.length > 0) {
    await c.env.DB.batch(deleteStatements);
  }

  // Clear all KV keys (paginated)
  let kvComplete = false;
  let kvCursor: string | undefined;
  while (!kvComplete) {
    const result = await kv.list({ limit: 1000, cursor: kvCursor });
    await Promise.all(result.keys.map((k) => kv.delete(k.name)));
    kvComplete = result.list_complete;
    kvCursor = result.cursor;
  }

  // Clear all R2 objects (paginated)
  let r2Cursor: string | undefined;
  for (;;) {
    const result = await storage.list({ limit: 1000, cursor: r2Cursor });
    await Promise.all(result.objects.map((obj) => storage.delete(obj.key)));
    if (!result.truncated) {
      break;
    }
    r2Cursor = result.cursor;
  }

  return { ok: true };
});
