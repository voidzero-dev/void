import { defineHandler } from 'void';

const records = new Map<string, string>();
export type Props = { id: string; name: string };
export const loader = defineHandler<Props>((c) => {
  const id = c.req.param('id');
  if (id === undefined) {
    return c.notFound();
  }
  return { id, name: records.get(id) ?? `Record ${id}` };
});
export const action = defineHandler(async (c) => {
  const id = c.req.param('id');
  if (id === undefined) {
    return c.notFound();
  }
  const { name } = await c.req.json<{ name: string }>();
  records.set(id, name);
});
